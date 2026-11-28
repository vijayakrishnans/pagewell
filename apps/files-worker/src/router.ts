import type { DriveAction } from "@saas/contracts/sharing";
import { createSqlExecutor } from "@saas/db/d1";
import { createEventsRepository } from "@saas/db/events";
import { createFilesRepository, createSharingRepository, type ResourceRef } from "@saas/db/files";
import type { Uuid } from "@saas/db/ids";
import { createAccess } from "./access.js";
import { createAuditor } from "./audit.js";
import { membershipFacts, resolveActor, type FilesAction } from "./auth.js";
import { positiveInt, type Ctx } from "./context.js";
import type { Env } from "./env.js";
import { fail, methodNotAllowed, notFound, ok, unavailable } from "./http.js";
import { fromPublic, generateRequestId, newUuid, toPublic } from "./ids.js";
import * as drive from "./handlers/drive.js";
import * as docs from "./handlers/documents.js";
import * as uploads from "./handlers/uploads.js";
import * as share from "./handlers/sharing.js";
import * as links from "./handlers/links.js";

// The drive API, behind api-edge (which authenticates and sets the actor headers).
//   /v1/organizations/{org}/…  the drive of one org: every id in the path is parsed before
//                              anything is read, and the caller's right is checked first —
//                              for the org as a whole, or for the one folder or document the
//                              route is about (org role + grants, decided by policy-worker).
//   /v1/me/shared              what is shared with the caller, in any org.
//   /v1/l/{token}…             a share link: no account, the token is the key.
// Every miss is the same 404.

const REQUEST_ID = /^[\w-]{1,128}$/;
const ORG_ROUTE = /^\/v1\/organizations\/([^/]+)(\/.*)$/;
const LINK_ROUTE = /^\/v1\/l\/([A-Za-z0-9_-]{20,128})(\/.*)?$/;

type Handler = (ctx: Ctx, request: Request, url: URL) => Promise<Response>;
/**
 * Who may call a route: an org-wide action (members), an action on the folder or document in
 * the path, or "handler" when the handler checks for itself (the target is in the body, or
 * only the person who started an upload may continue it).
 */
type Scope = { org: FilesAction } | { on: DriveAction } | "handler";
interface Built {
  handler: Handler;
  resource?: ResourceRef;
}
interface Route {
  method: string;
  pattern: RegExp;
  scope: Scope;
  build: (m: RegExpMatchArray) => Built | null;
}

const num = (m: RegExpMatchArray, i: number) => positiveInt(m[i]);
const onDoc = (m: RegExpMatchArray, h: (id: Uuid) => Handler): Built | null => {
  const id = fromPublic("doc", m[1]);
  return id ? { handler: h(id), resource: { kind: "document", id } } : null;
};
const onDocVersion = (m: RegExpMatchArray, h: (id: Uuid, n: number) => Handler): Built | null => {
  const id = fromPublic("doc", m[1]);
  const n = num(m, 2);
  return id && n ? { handler: h(id, n), resource: { kind: "document", id } } : null;
};
const onFolder = (m: RegExpMatchArray, h: (id: Uuid) => Handler): Built | null => {
  const id = fromPublic("fld", m[1]);
  return id ? { handler: h(id), resource: { kind: "folder", id } } : null;
};
/** A sharing route on a folder or a document: …/(folders|documents)/{id}/… */
const onShared = (m: RegExpMatchArray, h: (r: ResourceRef) => Handler): Built | null => {
  const kind = m[1] === "folders" ? "folder" : "document";
  const id = fromPublic(kind === "folder" ? "fld" : "doc", m[2]);
  if (!id) return null;
  const r: ResourceRef = { kind, id };
  return { handler: h(r), resource: r };
};
const plain = (h: Handler): Built => ({ handler: h });
const upl = (m: RegExpMatchArray) => fromPublic("upl", m[1]);

const ROUTES: Route[] = [
  { method: "GET", pattern: /^\/folders$/, scope: { org: "files.read" }, build: () => plain((ctx) => drive.listFolder(ctx, null)) },
  { method: "POST", pattern: /^\/folders$/, scope: "handler", build: () => plain((ctx, req) => drive.createFolder(ctx, req, newUuid())) },
  { method: "GET", pattern: /^\/folders\/([^/]+)$/, scope: { on: "files.read" }, build: (m) => onFolder(m, (id) => (ctx) => drive.listFolder(ctx, id)) },
  { method: "PATCH", pattern: /^\/folders\/([^/]+)$/, scope: { on: "files.write" }, build: (m) => onFolder(m, (id) => (ctx, req) => drive.updateFolder(ctx, req, id)) },
  { method: "DELETE", pattern: /^\/folders\/([^/]+)$/, scope: { on: "files.delete" }, build: (m) => onFolder(m, (id) => (ctx) => drive.trashFolder(ctx, id)) },
  { method: "POST", pattern: /^\/folders\/([^/]+)\/restore$/, scope: { on: "files.delete" }, build: (m) => onFolder(m, (id) => (ctx) => drive.restoreFolder(ctx, id)) },

  { method: "GET", pattern: /^\/documents$/, scope: { org: "files.read" }, build: () => plain((ctx, _req, url) => docs.listRecent(ctx, url)) },
  { method: "POST", pattern: /^\/documents$/, scope: "handler", build: () => plain((ctx, req, url) => docs.uploadDocument(ctx, req, url)) },
  { method: "GET", pattern: /^\/documents\/([^/]+)$/, scope: { on: "files.read" }, build: (m) => onDoc(m, (id) => (ctx) => docs.getDocument(ctx, id)) },
  { method: "PATCH", pattern: /^\/documents\/([^/]+)$/, scope: { on: "files.write" }, build: (m) => onDoc(m, (id) => (ctx, req) => docs.updateDocument(ctx, req, id)) },
  { method: "DELETE", pattern: /^\/documents\/([^/]+)$/, scope: { on: "files.delete" }, build: (m) => onDoc(m, (id) => (ctx) => docs.trashDocument(ctx, id)) },
  { method: "POST", pattern: /^\/documents\/([^/]+)\/restore$/, scope: { on: "files.delete" }, build: (m) => onDoc(m, (id) => (ctx) => docs.restoreDocument(ctx, id)) },
  { method: "GET", pattern: /^\/documents\/([^/]+)\/content$/, scope: { on: "files.read" }, build: (m) => onDoc(m, (id) => (ctx, req, url) => docs.content(ctx, req, url, id)) },
  { method: "HEAD", pattern: /^\/documents\/([^/]+)\/content$/, scope: { on: "files.read" }, build: (m) => onDoc(m, (id) => (ctx, req, url) => docs.content(ctx, req, url, id)) },
  { method: "GET", pattern: /^\/documents\/([^/]+)\/versions$/, scope: { on: "files.read" }, build: (m) => onDoc(m, (id) => (ctx) => docs.listVersions(ctx, id)) },
  { method: "POST", pattern: /^\/documents\/([^/]+)\/versions$/, scope: { on: "files.write" }, build: (m) => onDoc(m, (id) => (ctx, req) => docs.saveVersion(ctx, req, id)) },
  { method: "POST", pattern: /^\/documents\/([^/]+)\/versions\/(\d+)\/restore$/, scope: { on: "files.write" }, build: (m) => onDocVersion(m, (id, n) => (ctx, req) => docs.restoreVersion(ctx, req, id, n)) },
  { method: "PUT", pattern: /^\/documents\/([^/]+)\/versions\/(\d+)\/thumbnail$/, scope: { on: "files.write" }, build: (m) => onDocVersion(m, (id, n) => (ctx, req) => docs.putThumbnail(ctx, req, id, n)) },
  { method: "GET", pattern: /^\/documents\/([^/]+)\/versions\/(\d+)\/thumbnail$/, scope: { on: "files.read" }, build: (m) => onDocVersion(m, (id, n) => (ctx) => docs.getThumbnail(ctx, id, n)) },
  { method: "PUT", pattern: /^\/documents\/([^/]+)\/versions\/(\d+)\/text$/, scope: { on: "files.write" }, build: (m) => onDocVersion(m, (id, n) => (ctx, req) => docs.putText(ctx, req, id, n)) },
  { method: "GET", pattern: /^\/documents\/([^/]+)\/versions\/(\d+)\/text$/, scope: { on: "files.read" }, build: (m) => onDocVersion(m, (id, n) => (ctx) => docs.getText(ctx, id, n)) },
  { method: "GET", pattern: /^\/documents\/([^/]+)\/activity$/, scope: { on: "files.read" }, build: (m) => onDoc(m, (id) => (ctx, _req, url) => share.activity(ctx, url, id)) },

  // Sharing, on a folder or a document.
  { method: "GET", pattern: /^\/(folders|documents)\/([^/]+)\/access$/, scope: { on: "files.read" }, build: (m) => onShared(m, (r) => (ctx) => share.myAccess(ctx, r)) },
  { method: "GET", pattern: /^\/(folders|documents)\/([^/]+)\/grants$/, scope: { on: "files.share" }, build: (m) => onShared(m, (r) => (ctx) => share.accessList(ctx, r)) },
  { method: "POST", pattern: /^\/(folders|documents)\/([^/]+)\/grants$/, scope: { on: "files.share" }, build: (m) => onShared(m, (r) => (ctx, req) => share.createGrant(ctx, req, r)) },
  {
    method: "DELETE",
    pattern: /^\/(folders|documents)\/([^/]+)\/grants\/([^/]+)$/,
    scope: { on: "files.share" },
    build: (m) => {
      const g = fromPublic("grt", m[3]);
      return g ? onShared(m, (r) => (ctx) => share.deleteGrant(ctx, r, g)) : null;
    },
  },
  { method: "GET", pattern: /^\/(folders|documents)\/([^/]+)\/links$/, scope: { on: "files.share" }, build: (m) => onShared(m, (r) => (ctx) => share.listLinks(ctx, r)) },
  { method: "POST", pattern: /^\/(folders|documents)\/([^/]+)\/links$/, scope: { on: "files.share" }, build: (m) => onShared(m, (r) => (ctx, req) => share.createLink(ctx, req, r)) },
  {
    method: "DELETE",
    pattern: /^\/(folders|documents)\/([^/]+)\/links\/([^/]+)$/,
    scope: { on: "files.share" },
    build: (m) => {
      const l = fromPublic("lnk", m[3]);
      return l ? onShared(m, (r) => (ctx) => share.revokeLink(ctx, r, l)) : null;
    },
  },
  { method: "GET", pattern: /^\/guests$/, scope: { org: "files.share" }, build: () => plain((ctx) => share.listGuests(ctx)) },
  {
    method: "DELETE",
    pattern: /^\/guests\/([^/]+)$/,
    scope: { org: "files.share" },
    build: (m) => {
      const g = fromPublic("gst", m[1]);
      return g ? plain((ctx) => share.removeGuest(ctx, g)) : null;
    },
  },

  { method: "POST", pattern: /^\/uploads$/, scope: "handler", build: () => plain((ctx, req) => uploads.createUpload(ctx, req)) },
  { method: "PUT", pattern: /^\/uploads\/([^/]+)\/parts\/(\d+)$/, scope: "handler", build: (m) => { const id = upl(m); const n = num(m, 2); return id && n ? plain((ctx, req) => uploads.putPart(ctx, req, id, n)) : null; } },
  { method: "POST", pattern: /^\/uploads\/([^/]+)\/complete$/, scope: "handler", build: (m) => { const id = upl(m); return id ? plain((ctx, req) => uploads.completeUpload(ctx, req, id)) : null; } },
  { method: "DELETE", pattern: /^\/uploads\/([^/]+)$/, scope: "handler", build: (m) => { const id = upl(m); return id ? plain((ctx) => uploads.abortUpload(ctx, id)) : null; } },

  { method: "GET", pattern: /^\/trash$/, scope: { org: "files.read" }, build: () => plain((ctx) => drive.listTrash(ctx)) },
  { method: "GET", pattern: /^\/quota$/, scope: { org: "files.read" }, build: () => plain((ctx) => drive.quota(ctx)) },
];

function logFailure(requestId: string, err: unknown) {
  // The error's class only: messages can carry document names.
  console.error(JSON.stringify({ level: "error", msg: "files-worker request failed", requestId, error: err instanceof Error ? err.name : "unknown" }));
}

export async function route(request: Request, env: Env, now: Date = new Date()): Promise<Response> {
  const url = new URL(request.url);
  const header = request.headers.get("x-request-id");
  const requestId = header && REQUEST_ID.test(header) ? header : generateRequestId();

  if (url.pathname === "/health" && request.method === "GET") {
    return ok({ ok: true, service: "files-worker", environment: env.ENVIRONMENT }, requestId);
  }

  const linkMatch = url.pathname.match(LINK_ROUTE);
  if (linkMatch) {
    if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(requestId);
    if (!env.PLATFORM_DB || !env.FILES_BUCKET) return unavailable(requestId);
    const executor = createSqlExecutor(env.PLATFORM_DB as never);
    try {
      return await links.open(
        { env, requestId, now, repo: createFilesRepository(executor), sharing: createSharingRepository(executor), events: createEventsRepository(executor), bucket: env.FILES_BUCKET },
        request,
        url,
        linkMatch[1]!,
        linkMatch[2] ?? "",
      );
    } catch (err) {
      logFailure(requestId, err);
      return unavailable(requestId);
    } finally {
      await executor.dispose();
    }
  }

  if (url.pathname === "/v1/me/shared") {
    if (request.method !== "GET") return methodNotAllowed(requestId);
    const actor = resolveActor(request);
    if (!actor) return fail("unauthenticated", "Authentication required", 401, requestId);
    if (!env.PLATFORM_DB) return unavailable(requestId);
    const executor = createSqlExecutor(env.PLATFORM_DB as never);
    try {
      return await share.sharedWithMe(createSharingRepository(executor), actor, requestId);
    } catch (err) {
      logFailure(requestId, err);
      return unavailable(requestId);
    } finally {
      await executor.dispose();
    }
  }

  const orgMatch = url.pathname.match(ORG_ROUTE);
  if (!orgMatch) return notFound(requestId);
  const rest = orgMatch[2]!;
  const candidates = ROUTES.filter((r) => r.pattern.test(rest));
  if (candidates.length === 0) return notFound(requestId);
  const matched = candidates.find((r) => r.method === request.method);
  if (!matched) return methodNotAllowed(requestId);

  const orgId = fromPublic("org", orgMatch[1]);
  const built = orgId ? matched.build(rest.match(matched.pattern)!) : null;
  if (!orgId || !built) return notFound(requestId);

  const actor = resolveActor(request);
  if (!actor) return fail("unauthenticated", "Authentication required", 401, requestId);
  if (!env.PLATFORM_DB || !env.FILES_BUCKET) return unavailable(requestId);
  const facts = await membershipFacts(env, actor, orgId, requestId);
  if (!facts) return notFound(requestId);

  const executor = createSqlExecutor(env.PLATFORM_DB as never);
  try {
    const sharing = createSharingRepository(executor);
    const audit = createAuditor({ events: createEventsRepository(executor), orgId, actor: { type: actor.subjectType, id: actor.subjectId }, requestId, now });
    const access = createAccess({
      env,
      actor,
      orgId,
      facts,
      sharing,
      requestId,
      onGuestAllowed: async () => {
        if (!actor.email) return;
        const guests = await sharing.guestsForEmail(orgId, actor.email);
        for (const g of guests.ok ? guests.value : []) {
          const v = await sharing.verifyGuest(orgId, g.id as Uuid, actor.subjectId, now);
          if (v.ok && v.value.firstTime) await audit.record("guest.verified", { kind: "organization", id: orgId }, `Guest ${g.email} signed in and opened something shared with them`, { guestId: toPublic("gst", g.id) });
        }
      },
    });

    const scope = matched.scope;
    if (scope !== "handler") {
      const allowed = "org" in scope ? await access.org(scope.org) : built.resource ? await access.can(scope.on, built.resource) : false;
      if (!allowed) return notFound(requestId);
    }

    const ctx: Ctx = {
      env,
      requestId,
      actor,
      orgId,
      orgPublic: toPublic("org", orgId),
      repo: createFilesRepository(executor),
      sharing,
      access,
      audit,
      bucket: env.FILES_BUCKET,
      now,
    };
    return await built.handler(ctx, request, url);
  } catch (err) {
    logFailure(requestId, err);
    return unavailable(requestId);
  } finally {
    await executor.dispose();
  }
}
