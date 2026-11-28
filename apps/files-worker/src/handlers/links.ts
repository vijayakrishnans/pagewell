import { LINK_PASSWORD_HEADER, type LinkOpenResponse } from "@saas/contracts/sharing";
import type { EventsRepository } from "@saas/db/events";
import type { FilesRepository, ResourceRef, ShareLink, SharingRepository } from "@saas/db/files";
import type { Uuid } from "@saas/db/ids";
import { keyBelongsTo } from "@saas/shared/r2-keys";
import { createAuditor } from "../audit.js";
import { filesPermissions } from "../auth.js";
import { sha256Hex, verifyPassword } from "../crypto.js";
import type { Env } from "../env.js";
import { fail, notFound, ok, unavailable } from "../http.js";
import { fromPublic, toPublic } from "../ids.js";
import { publicDocument, publicFolder } from "../public.js";

// A share link, opened by anyone who has it (PW3). The token is the key: it is hashed and
// looked up, and a missing, revoked or expired link is the same 404 as anything else. A link
// with a password wants it in X-Pagewell-Link-Password on every request. What a link can do
// is decided by policy like every other access (principal "link", read or comment only).
//
//   GET /v1/l/{token}                     the linked document, or the linked folder's listing
//                                         (?folderId= for a folder inside it)
//   GET /v1/l/{token}/content?documentId= the PDF (a folder link names a document inside it)

export interface LinkCtx {
  env: Env;
  requestId: string;
  now: Date;
  repo: FilesRepository;
  sharing: SharingRepository;
  events: EventsRepository | null;
  bucket: R2Bucket;
}

// The owner's user id is not a link holder's business.
const anonymous = <T extends { ownerUserId: string }>(d: T): T => ({ ...d, ownerUserId: "" });

async function hashed(prefix: string, value: string | null, now: Date): Promise<string | null> {
  // Hashed with the day: opens can be told apart within a day, not followed across days.
  return value ? sha256Hex(`${prefix}|${now.toISOString().slice(0, 10)}|${value}`) : null;
}

export async function open(ctx: LinkCtx, request: Request, url: URL, token: string, sub: string): Promise<Response> {
  const found = await ctx.sharing.linkByTokenHash(await sha256Hex(token));
  if (!found.ok) return found.error.kind === "not_found" ? notFound(ctx.requestId) : unavailable(ctx.requestId);
  const link = found.value;
  if (link.revokedAt || (link.expiresAt && link.expiresAt <= ctx.now)) return notFound(ctx.requestId);
  if (link.passwordHash) {
    const given = request.headers.get(LINK_PASSWORD_HEADER);
    if (!given || given.length > 200 || !(await verifyPassword(given, link.passwordHash))) {
      return fail("link_password_required", "This link needs its password", 401, ctx.requestId);
    }
  }
  const orgId = link.orgId as Uuid;
  const resource: ResourceRef = { kind: link.resourceKind, id: link.resourceId as Uuid };
  const allowed = await filesPermissions(ctx.env, null, orgId, [], resource, { principal: "link", grants: [], link: link.role }, ctx.requestId);
  if (!allowed.has("files.read")) return notFound(ctx.requestId);

  if (sub === "" || sub === "/") return describe(ctx, request, url, link, resource);
  if (sub === "/content") return content(ctx, request, url, link, resource);
  return notFound(ctx.requestId);
}

async function describe(ctx: LinkCtx, request: Request, url: URL, link: ShareLink, resource: ResourceRef): Promise<Response> {
  const orgId = link.orgId as Uuid;
  const body: LinkOpenResponse = {
    link: { role: link.role, allowDownload: link.allowDownload, expiresAt: link.expiresAt?.toISOString() ?? null },
    folder: null,
    document: null,
    folders: [],
    documents: [],
  };
  let name: string;
  if (resource.kind === "document") {
    const d = await ctx.repo.getDocument(orgId, resource.id);
    if (!d.ok || d.value.deletedAt) return notFound(ctx.requestId);
    body.document = anonymous(publicDocument(d.value));
    name = d.value.name;
  } else {
    const asked = url.searchParams.get("folderId");
    let target = resource.id;
    if (asked) {
      const id = fromPublic("fld", asked);
      if (!id) return notFound(ctx.requestId);
      const inside = await ctx.sharing.withinFolder(orgId, resource.id, { kind: "folder", id });
      if (!inside.ok || !inside.value) return notFound(ctx.requestId);
      target = id;
    }
    const f = await ctx.repo.getFolder(orgId, target);
    const top = await ctx.repo.getFolder(orgId, resource.id);
    if (!f.ok || f.value.deletedAt || !top.ok || top.value.deletedAt) return notFound(ctx.requestId);
    const listing = await ctx.repo.listFolder(orgId, target);
    if (!listing.ok) return notFound(ctx.requestId);
    body.folder = publicFolder(f.value);
    body.folders = listing.value.folders.map(publicFolder);
    body.documents = listing.value.documents.map((d) => anonymous(publicDocument(d)));
    name = top.value.name;
  }

  await ctx.sharing.recordLinkOpen(
    orgId,
    link.id as Uuid,
    ctx.now,
    await hashed("ip", request.headers.get("cf-connecting-ip"), ctx.now),
    await hashed("ua", request.headers.get("user-agent"), ctx.now),
  );
  // One audit entry per open of the link itself, not per folder browsed inside it.
  if (!url.searchParams.get("folderId")) {
    const audit = createAuditor({ events: ctx.events, orgId, actor: { type: "share_link", id: toPublic("lnk", link.id) }, requestId: ctx.requestId, now: ctx.now });
    await audit.record("link.opened", { kind: resource.kind, id: resource.id, name }, `A ${link.role} link to ${resource.kind === "folder" ? "folder" : "document"} "${name}" was opened`, {
      linkId: toPublic("lnk", link.id),
    });
  }
  return ok(body, ctx.requestId);
}

async function content(ctx: LinkCtx, request: Request, url: URL, link: ShareLink, resource: ResourceRef): Promise<Response> {
  const orgId = link.orgId as Uuid;
  let docId: Uuid | null;
  if (resource.kind === "document") {
    const asked = url.searchParams.get("documentId");
    docId = asked && fromPublic("doc", asked) !== resource.id ? null : resource.id;
  } else {
    docId = fromPublic("doc", url.searchParams.get("documentId"));
    if (docId) {
      const inside = await ctx.sharing.withinFolder(orgId, resource.id, { kind: "document", id: docId });
      if (!inside.ok || !inside.value) docId = null;
    }
  }
  if (!docId) return notFound(ctx.requestId);
  const d = await ctx.repo.getDocument(orgId, docId);
  if (!d.ok || d.value.deletedAt) return notFound(ctx.requestId);
  const v = await ctx.repo.getVersion(orgId, docId, d.value.currentVersion);
  if (!v.ok || !keyBelongsTo(v.value.r2Key, orgId)) return notFound(ctx.requestId);
  const obj = await ctx.bucket.get(v.value.r2Key);
  if (!obj) return notFound(ctx.requestId);
  const headers = new Headers({
    "content-type": "application/pdf",
    "content-length": String(obj.size),
    "x-pagewell-version": String(d.value.currentVersion),
    "x-pagewell-allow-download": link.allowDownload ? "1" : "0",
    "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(d.value.name)}`,
    // Never cached: a revoked link must stop serving on the next request.
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  return new Response(request.method === "HEAD" ? null : obj.body, { status: 200, headers });
}
