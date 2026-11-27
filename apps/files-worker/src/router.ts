import { createSqlExecutor } from "@saas/db/d1";
import { createFilesRepository } from "@saas/db/files";
import type { Uuid } from "@saas/db/ids";
import { authorize, resolveActor, type FilesAction } from "./auth.js";
import { positiveInt, type Ctx } from "./context.js";
import type { Env } from "./env.js";
import { fail, methodNotAllowed, notFound, ok, unavailable } from "./http.js";
import { fromPublic, generateRequestId, newUuid, toPublic } from "./ids.js";
import * as drive from "./handlers/drive.js";
import * as docs from "./handlers/documents.js";
import * as uploads from "./handlers/uploads.js";

// The drive API, behind api-edge (which authenticates and sets the actor
// headers). Every route is under /v1/organizations/{org}/; the org and every
// id in the path are parsed before anything is read, the caller's right in
// the org is checked before any row is, and every miss is the same 404.

const REQUEST_ID = /^[\w-]{1,128}$/;
const ORG_ROUTE = /^\/v1\/organizations\/([^/]+)(\/.*)$/;

type Handler = (ctx: Ctx, request: Request, url: URL) => Promise<Response>;
interface Route {
  method: string;
  pattern: RegExp;
  action: FilesAction;
  /** Turn the path's captures into the handler, or null when an id is malformed. */
  build: (m: RegExpMatchArray) => Handler | null;
}

const doc = (m: RegExpMatchArray, i = 1) => fromPublic("doc", m[i]);
const fld = (m: RegExpMatchArray, i = 1) => fromPublic("fld", m[i]);
const upl = (m: RegExpMatchArray, i = 1) => fromPublic("upl", m[i]);
const num = (m: RegExpMatchArray, i: number) => positiveInt(m[i]);
const withDoc = (m: RegExpMatchArray, h: (id: Uuid) => Handler) => {
  const id = doc(m);
  return id ? h(id) : null;
};
const withDocVersion = (m: RegExpMatchArray, h: (id: Uuid, n: number) => Handler) => {
  const id = doc(m);
  const n = num(m, 2);
  return id && n ? h(id, n) : null;
};

const ROUTES: Route[] = [
  { method: "GET", pattern: /^\/folders$/, action: "files.read", build: () => (ctx) => drive.listFolder(ctx, null) },
  { method: "POST", pattern: /^\/folders$/, action: "files.write", build: () => (ctx, req) => drive.createFolder(ctx, req, newUuid()) },
  { method: "GET", pattern: /^\/folders\/([^/]+)$/, action: "files.read", build: (m) => { const id = fld(m); return id ? (ctx) => drive.listFolder(ctx, id) : null; } },
  { method: "PATCH", pattern: /^\/folders\/([^/]+)$/, action: "files.write", build: (m) => { const id = fld(m); return id ? (ctx, req) => drive.updateFolder(ctx, req, id) : null; } },
  { method: "DELETE", pattern: /^\/folders\/([^/]+)$/, action: "files.delete", build: (m) => { const id = fld(m); return id ? (ctx) => drive.trashFolder(ctx, id) : null; } },
  { method: "POST", pattern: /^\/folders\/([^/]+)\/restore$/, action: "files.delete", build: (m) => { const id = fld(m); return id ? (ctx) => drive.restoreFolder(ctx, id) : null; } },

  { method: "GET", pattern: /^\/documents$/, action: "files.read", build: () => (ctx, _req, url) => docs.listRecent(ctx, url) },
  { method: "POST", pattern: /^\/documents$/, action: "files.write", build: () => (ctx, req, url) => docs.uploadDocument(ctx, req, url) },
  { method: "GET", pattern: /^\/documents\/([^/]+)$/, action: "files.read", build: (m) => withDoc(m, (id) => (ctx) => docs.getDocument(ctx, id)) },
  { method: "PATCH", pattern: /^\/documents\/([^/]+)$/, action: "files.write", build: (m) => withDoc(m, (id) => (ctx, req) => docs.updateDocument(ctx, req, id)) },
  { method: "DELETE", pattern: /^\/documents\/([^/]+)$/, action: "files.delete", build: (m) => withDoc(m, (id) => (ctx) => docs.trashDocument(ctx, id)) },
  { method: "POST", pattern: /^\/documents\/([^/]+)\/restore$/, action: "files.delete", build: (m) => withDoc(m, (id) => (ctx) => docs.restoreDocument(ctx, id)) },
  { method: "GET", pattern: /^\/documents\/([^/]+)\/content$/, action: "files.read", build: (m) => withDoc(m, (id) => (ctx, req, url) => docs.content(ctx, req, url, id)) },
  { method: "HEAD", pattern: /^\/documents\/([^/]+)\/content$/, action: "files.read", build: (m) => withDoc(m, (id) => (ctx, req, url) => docs.content(ctx, req, url, id)) },
  { method: "GET", pattern: /^\/documents\/([^/]+)\/versions$/, action: "files.read", build: (m) => withDoc(m, (id) => (ctx) => docs.listVersions(ctx, id)) },
  { method: "POST", pattern: /^\/documents\/([^/]+)\/versions$/, action: "files.write", build: (m) => withDoc(m, (id) => (ctx, req) => docs.saveVersion(ctx, req, id)) },
  { method: "POST", pattern: /^\/documents\/([^/]+)\/versions\/(\d+)\/restore$/, action: "files.write", build: (m) => withDocVersion(m, (id, n) => (ctx, req) => docs.restoreVersion(ctx, req, id, n)) },
  { method: "PUT", pattern: /^\/documents\/([^/]+)\/versions\/(\d+)\/thumbnail$/, action: "files.write", build: (m) => withDocVersion(m, (id, n) => (ctx, req) => docs.putThumbnail(ctx, req, id, n)) },
  { method: "GET", pattern: /^\/documents\/([^/]+)\/versions\/(\d+)\/thumbnail$/, action: "files.read", build: (m) => withDocVersion(m, (id, n) => (ctx) => docs.getThumbnail(ctx, id, n)) },
  { method: "PUT", pattern: /^\/documents\/([^/]+)\/versions\/(\d+)\/text$/, action: "files.write", build: (m) => withDocVersion(m, (id, n) => (ctx, req) => docs.putText(ctx, req, id, n)) },

  { method: "POST", pattern: /^\/uploads$/, action: "files.write", build: () => (ctx, req) => uploads.createUpload(ctx, req) },
  { method: "PUT", pattern: /^\/uploads\/([^/]+)\/parts\/(\d+)$/, action: "files.write", build: (m) => { const id = upl(m); const n = num(m, 2); return id && n ? (ctx, req) => uploads.putPart(ctx, req, id, n) : null; } },
  { method: "POST", pattern: /^\/uploads\/([^/]+)\/complete$/, action: "files.write", build: (m) => { const id = upl(m); return id ? (ctx, req) => uploads.completeUpload(ctx, req, id) : null; } },
  { method: "DELETE", pattern: /^\/uploads\/([^/]+)$/, action: "files.write", build: (m) => { const id = upl(m); return id ? (ctx) => uploads.abortUpload(ctx, id) : null; } },

  { method: "GET", pattern: /^\/trash$/, action: "files.read", build: () => (ctx) => drive.listTrash(ctx) },
  { method: "GET", pattern: /^\/quota$/, action: "files.read", build: () => (ctx) => drive.quota(ctx) },
];

export async function route(request: Request, env: Env, now: Date = new Date()): Promise<Response> {
  const url = new URL(request.url);
  const header = request.headers.get("x-request-id");
  const requestId = header && REQUEST_ID.test(header) ? header : generateRequestId();

  if (url.pathname === "/health" && request.method === "GET") {
    return ok({ ok: true, service: "files-worker", environment: env.ENVIRONMENT }, requestId);
  }

  const orgMatch = url.pathname.match(ORG_ROUTE);
  if (!orgMatch) return notFound(requestId);
  const rest = orgMatch[2]!;
  const candidates = ROUTES.filter((r) => r.pattern.test(rest));
  if (candidates.length === 0) return notFound(requestId);
  const matched = candidates.find((r) => r.method === request.method);
  if (!matched) return methodNotAllowed(requestId);

  const orgId = fromPublic("org", orgMatch[1]);
  const handler = orgId ? matched.build(rest.match(matched.pattern)!) : null;
  if (!orgId || !handler) return notFound(requestId);

  const actor = resolveActor(request);
  if (!actor) return fail("unauthenticated", "Authentication required", 401, requestId);
  if (!env.PLATFORM_DB || !env.FILES_BUCKET) return unavailable(requestId);
  if (!(await authorize(env, actor, orgId, matched.action, requestId))) return notFound(requestId);

  const executor = createSqlExecutor(env.PLATFORM_DB as never);
  try {
    const ctx: Ctx = {
      env,
      requestId,
      actor,
      orgId,
      orgPublic: toPublic("org", orgId),
      repo: createFilesRepository(executor),
      bucket: env.FILES_BUCKET,
      now,
    };
    return await handler(ctx, request, url);
  } catch (err) {
    // The error's class only: messages can carry document names.
    console.error(JSON.stringify({ level: "error", msg: "files-worker request failed", requestId, error: err instanceof Error ? err.name : "unknown" }));
    return unavailable(requestId);
  } finally {
    await executor.dispose();
  }
}
