import { LINK_MAX_DAYS, LINK_PASSWORD_MAX, LINK_PASSWORD_MIN, type AccessListResponse, type DriveRole, type LinkRole, type SharedItem } from "@saas/contracts/sharing";
import type { Grant, Guest, ResourceRef, SharingRepository } from "@saas/db/files";
import type { Uuid } from "@saas/db/ids";
import { membershipFacts, type Actor } from "../auth.js";
import { positiveInt, type Ctx } from "../context.js";
import { hashPassword, newLinkToken, sha256Hex } from "../crypto.js";
import { invalid, notFound, ok, readJson, unavailable } from "../http.js";
import { newUuid, toPublic } from "../ids.js";
import { publicGrant, publicGuest, publicLink } from "../public.js";

// Sharing a folder or a document (PW3): who has access (with inherited grants), adding and
// removing people, share links, the org's guests, a document's activity, and Shared with me.
// The router has already checked the caller's right on the resource (files.share to manage,
// files.read to look); everything here re-reads the resource so a trashed one is a 404.

const ROLES: readonly DriveRole[] = ["editor", "commenter", "viewer"];
const LINK_ROLES: readonly LinkRole[] = ["viewer", "commenter"];
const USER_ID = /^usr_[0-9a-f]{32}$/;
const EMAIL = /^[^\s@]{1,200}@[^\s@]{1,200}\.[^\s@]{1,63}$/;

/** The live resource's name, or null (missing, trashed, or another org's). */
async function liveName(ctx: Ctx, r: ResourceRef): Promise<string | null> {
  if (r.kind === "folder") {
    const f = await ctx.repo.getFolder(ctx.orgId, r.id);
    return f.ok && !f.value.deletedAt ? f.value.name : null;
  }
  const d = await ctx.repo.getDocument(ctx.orgId, r.id);
  return d.ok && !d.value.deletedAt ? d.value.name : null;
}

const pub = (r: ResourceRef) => toPublic(r.kind === "folder" ? "fld" : "doc", r.id);
const what = (r: ResourceRef, name: string) => `${r.kind === "folder" ? "folder" : "document"} "${name}"`;

/** GET …/access: what the caller may do here. */
export async function myAccess(ctx: Ctx, r: ResourceRef): Promise<Response> {
  if (!(await liveName(ctx, r))) return notFound(ctx.requestId);
  return ok({ access: await ctx.access.describe(r) }, ctx.requestId);
}

async function describeGrants(ctx: Ctx, r: ResourceRef, grants: Grant[]) {
  const guests = new Map<string, Guest | null>();
  const folders = new Map<string, string>();
  const out = [];
  for (const g of grants) {
    let guest: Guest | null = null;
    if (g.principalKind === "guest") {
      if (!guests.has(g.principalId)) {
        const found = await ctx.sharing.getGuest(ctx.orgId, g.principalId as Uuid);
        guests.set(g.principalId, found.ok && !found.value.removedAt ? found.value : null);
      }
      guest = guests.get(g.principalId) ?? null;
      if (!guest) continue;
    }
    let from: { folderId: string; name: string } | null = null;
    const own = g.resourceKind === r.kind && g.resourceId === r.id;
    if (!own) {
      if (!folders.has(g.resourceId)) {
        const f = await ctx.repo.getFolder(ctx.orgId, g.resourceId as Uuid);
        folders.set(g.resourceId, f.ok ? f.value.name : "");
      }
      from = { folderId: g.resourceId, name: folders.get(g.resourceId) ?? "" };
    }
    out.push(publicGrant(g, guest, from));
  }
  return out;
}

/** GET …/grants: everyone with access (inherited grants say which folder they come from), the live links, and the caller's own access. */
export async function accessList(ctx: Ctx, r: ResourceRef): Promise<Response> {
  if (!(await liveName(ctx, r))) return notFound(ctx.requestId);
  const [grants, links] = await Promise.all([ctx.sharing.grantsReaching(ctx.orgId, r), ctx.sharing.listLinks(ctx.orgId, r)]);
  if (!grants.ok || !links.ok) return unavailable(ctx.requestId);
  const body: AccessListResponse = {
    grants: await describeGrants(ctx, r, grants.value),
    links: links.value.map(publicLink),
    access: await ctx.access.describe(r),
  };
  return ok(body, ctx.requestId);
}

/** POST …/grants {userId | email, role}: add someone, or change their role here. */
export async function createGrant(ctx: Ctx, request: Request, r: ResourceRef): Promise<Response> {
  const body = await readJson(request);
  const role = ROLES.find((x) => x === body?.role);
  const userId = typeof body?.userId === "string" ? body.userId : null;
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : null;
  const name = typeof body?.name === "string" && body.name.trim().length > 0 ? body.name.trim().slice(0, 200) : null;
  const fields: Record<string, string[]> = {};
  if (!role) fields.role = ["editor, commenter or viewer"];
  if (!userId === !email) fields.principal = ["exactly one of userId or email"];
  if (userId && !USER_ID.test(userId)) fields.userId = ["a user id (usr_…)"];
  if (email && (!EMAIL.test(email) || email.length > 320)) fields.email = ["an email address"];
  if (Object.keys(fields).length || !role) return invalid(ctx.requestId, fields);

  const resourceName = await liveName(ctx, r);
  if (!resourceName) return notFound(ctx.requestId);

  let principal: { kind: "member" | "guest"; id: string; label: string };
  if (userId) {
    // A member grant names someone in this org; anyone else is shared with by email.
    const facts = await membershipFacts(ctx.env, { subjectId: userId, subjectType: "user", email: null }, ctx.orgId, ctx.requestId);
    if (!facts?.some((f) => f.scope?.kind === "organization" && f.scope.orgId === ctx.orgId)) {
      return invalid(ctx.requestId, { userId: ["not a member of this organization; share by email instead"] });
    }
    principal = { kind: "member", id: userId, label: userId };
  } else {
    const g = await ctx.sharing.inviteGuest({ id: newUuid(), orgId: ctx.orgId, email: email!, name, invitedBy: ctx.actor.subjectId, now: ctx.now });
    if (!g.ok) return unavailable(ctx.requestId);
    if (g.value.created) {
      await ctx.audit.record("guest.invited", { kind: "organization", id: ctx.orgId }, `Invited guest ${g.value.guest.email}`, { guestId: toPublic("gst", g.value.guest.id) });
    }
    principal = { kind: "guest", id: g.value.guest.id, label: g.value.guest.email };
  }

  // eslint-disable-next-line no-restricted-syntax -- files_* actor columns are TEXT and keep the public actor id (usr_/sp_), so the kind survives
  const put = await ctx.sharing.putGrant({ id: newUuid(), orgId: ctx.orgId, resource: r, principalKind: principal.kind, principalId: principal.id, role, createdBy: ctx.actor.subjectId, now: ctx.now });
  if (!put.ok) return unavailable(ctx.requestId);
  const { grant, created, previousRole } = put.value;
  await ctx.audit.record(
    created ? "grant.created" : "grant.updated",
    { kind: r.kind, id: r.id, name: resourceName },
    created ? `Shared ${what(r, resourceName)} with ${principal.label} as ${role}` : `Changed ${principal.label} on ${what(r, resourceName)} from ${previousRole ?? "?"} to ${role}`,
    { grantId: toPublic("grt", grant.id), resource: pub(r), principalKind: principal.kind, role, previousRole },
  );
  const [described] = await describeGrants(ctx, r, [grant]);
  return ok({ grant: described }, ctx.requestId, created ? 201 : 200);
}

/** DELETE …/grants/{grt}: remove a grant that sits on this resource (inherited ones are removed on their folder). */
export async function deleteGrant(ctx: Ctx, r: ResourceRef, grantId: Uuid): Promise<Response> {
  const resourceName = await liveName(ctx, r);
  if (!resourceName) return notFound(ctx.requestId);
  const g = await ctx.sharing.getGrant(ctx.orgId, grantId);
  if (!g.ok || g.value.resourceKind !== r.kind || g.value.resourceId !== r.id) return notFound(ctx.requestId);
  const removed = await ctx.sharing.deleteGrant(ctx.orgId, grantId);
  if (!removed.ok) return removed.error.kind === "not_found" ? notFound(ctx.requestId) : unavailable(ctx.requestId);
  let label = removed.value.principalId;
  if (removed.value.principalKind === "guest") {
    const guest = await ctx.sharing.getGuest(ctx.orgId, removed.value.principalId as Uuid);
    if (guest.ok) label = guest.value.email;
  }
  await ctx.audit.record("grant.deleted", { kind: r.kind, id: r.id, name: resourceName }, `Removed ${label}'s ${removed.value.role} access to ${what(r, resourceName)}`, {
    grantId: toPublic("grt", grantId),
    resource: pub(r),
    principalKind: removed.value.principalKind,
    role: removed.value.role,
  });
  return new Response(null, { status: 204 });
}

export async function listLinks(ctx: Ctx, r: ResourceRef): Promise<Response> {
  if (!(await liveName(ctx, r))) return notFound(ctx.requestId);
  const links = await ctx.sharing.listLinks(ctx.orgId, r);
  if (!links.ok) return unavailable(ctx.requestId);
  return ok({ links: links.value.map(publicLink) }, ctx.requestId);
}

/** POST …/links {role, password?, expiresAt?, allowDownload?}: the token is in this response only. */
export async function createLink(ctx: Ctx, request: Request, r: ResourceRef): Promise<Response> {
  const body = await readJson(request);
  const role = LINK_ROLES.find((x) => x === body?.role);
  const password = body?.password === undefined || body?.password === null || body?.password === "" ? null : body.password;
  const expiresRaw = body?.expiresAt === undefined || body?.expiresAt === null || body?.expiresAt === "" ? null : body.expiresAt;
  const allowDownload = body?.allowDownload === undefined ? true : body.allowDownload;
  const fields: Record<string, string[]> = {};
  if (!role) fields.role = ["viewer or commenter (a link never edits)"];
  if (password !== null && (typeof password !== "string" || password.length < LINK_PASSWORD_MIN || password.length > LINK_PASSWORD_MAX)) {
    fields.password = [`${LINK_PASSWORD_MIN}–${LINK_PASSWORD_MAX} characters`];
  }
  let expiresAt: Date | null = null;
  if (expiresRaw !== null) {
    const t = typeof expiresRaw === "string" ? Date.parse(expiresRaw) : NaN;
    if (Number.isNaN(t) || t <= ctx.now.getTime() || t > ctx.now.getTime() + LINK_MAX_DAYS * 86_400_000) fields.expiresAt = [`a time in the next ${LINK_MAX_DAYS} days`];
    else expiresAt = new Date(t);
  }
  if (typeof allowDownload !== "boolean") fields.allowDownload = ["true or false"];
  if (Object.keys(fields).length || !role) return invalid(ctx.requestId, fields);

  const resourceName = await liveName(ctx, r);
  if (!resourceName) return notFound(ctx.requestId);
  const token = newLinkToken();
  const link = await ctx.sharing.createLink({
    id: newUuid(),
    orgId: ctx.orgId,
    resource: r,
    role,
    tokenHash: await sha256Hex(token),
    passwordHash: password ? await hashPassword(password as string) : null,
    expiresAt,
    allowDownload: allowDownload as boolean,
    // eslint-disable-next-line no-restricted-syntax -- files_* actor columns are TEXT and keep the public actor id (usr_/sp_), so the kind survives
    createdBy: ctx.actor.subjectId,
    now: ctx.now,
  });
  if (!link.ok) return unavailable(ctx.requestId);
  await ctx.audit.record("link.created", { kind: r.kind, id: r.id, name: resourceName }, `Created a ${role} link to ${what(r, resourceName)}`, {
    linkId: toPublic("lnk", link.value.id),
    resource: pub(r),
    role,
    hasPassword: Boolean(password),
    expiresAt: expiresAt?.toISOString() ?? null,
    allowDownload,
  });
  return ok({ link: publicLink(link.value), token }, ctx.requestId, 201);
}

/** DELETE …/links/{lnk}: the link stops working on the next request. */
export async function revokeLink(ctx: Ctx, r: ResourceRef, linkId: Uuid): Promise<Response> {
  const resourceName = await liveName(ctx, r);
  if (!resourceName) return notFound(ctx.requestId);
  const l = await ctx.sharing.getLink(ctx.orgId, linkId);
  if (!l.ok || l.value.resourceKind !== r.kind || l.value.resourceId !== r.id || l.value.revokedAt) return notFound(ctx.requestId);
  const revoked = await ctx.sharing.revokeLink(ctx.orgId, linkId, ctx.now);
  if (!revoked.ok) return revoked.error.kind === "not_found" ? notFound(ctx.requestId) : unavailable(ctx.requestId);
  await ctx.audit.record("link.revoked", { kind: r.kind, id: r.id, name: resourceName }, `Turned off a ${revoked.value.role} link to ${what(r, resourceName)}`, {
    linkId: toPublic("lnk", linkId),
    resource: pub(r),
  });
  return new Response(null, { status: 204 });
}

export async function listGuests(ctx: Ctx): Promise<Response> {
  const guests = await ctx.sharing.listGuests(ctx.orgId);
  if (!guests.ok) return unavailable(ctx.requestId);
  return ok({ guests: guests.value.map(publicGuest) }, ctx.requestId);
}

/** DELETE /guests/{gst}: the guest loses every grant at once. */
export async function removeGuest(ctx: Ctx, guestId: Uuid): Promise<Response> {
  const removed = await ctx.sharing.removeGuest(ctx.orgId, guestId, ctx.now);
  if (!removed.ok) return removed.error.kind === "not_found" ? notFound(ctx.requestId) : unavailable(ctx.requestId);
  await ctx.audit.record("guest.removed", { kind: "organization", id: ctx.orgId }, `Removed guest ${removed.value.guest.email} and ${removed.value.grants} grant(s)`, {
    guestId: toPublic("gst", guestId),
    grants: removed.value.grants,
  });
  return new Response(null, { status: 204 });
}

/** GET /documents/{doc}/activity?cursor=&limit=: what happened to this document, newest first. */
export async function activity(ctx: Ctx, url: URL, docId: Uuid): Promise<Response> {
  const d = await ctx.repo.getDocument(ctx.orgId, docId);
  if (!d.ok) return notFound(ctx.requestId);
  const limit = positiveInt(url.searchParams.get("limit"), 100) ?? 50;
  const page = await ctx.audit.history({ kind: "document", id: docId }, limit, url.searchParams.get("cursor"));
  if (!page) return invalid(ctx.requestId, { cursor: ["invalid"] });
  return ok({ entries: page.entries, nextCursor: page.nextCursor }, ctx.requestId, 200, page.nextCursor);
}

/** GET /v1/me/shared: what has been shared with the caller, in any org, as a member or by email. */
export async function sharedWithMe(sharing: SharingRepository, actor: Actor, requestId: string): Promise<Response> {
  const memberId = actor.subjectType === "user" ? actor.subjectId : null;
  const r = await sharing.sharedWith({ memberId, email: actor.email });
  if (!r.ok) return unavailable(requestId);
  // One entry per resource: the widest role if both a member and a guest grant reach it.
  const best = new Map<string, SharedItem>();
  const rank = { viewer: 1, commenter: 2, editor: 3 } as const;
  for (const item of r.value) {
    const k = `${item.grant.orgId}:${item.grant.resourceKind}:${item.grant.resourceId}`;
    const entry: SharedItem = {
      orgId: toPublic("org", item.grant.orgId),
      resource: { kind: item.grant.resourceKind, id: toPublic(item.grant.resourceKind === "folder" ? "fld" : "doc", item.grant.resourceId) },
      name: item.name,
      role: item.grant.role,
      updatedAt: item.updatedAt.toISOString(),
      document: item.document ? { ...item.document, folderId: item.document.folderId ? toPublic("fld", item.document.folderId) : null } : null,
    };
    const prev = best.get(k);
    if (!prev || rank[entry.role] > rank[prev.role]) best.set(k, entry);
  }
  return ok({ items: [...best.values()] }, requestId);
}
