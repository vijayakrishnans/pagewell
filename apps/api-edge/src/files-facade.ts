// Pagewell's drive (PW2): /v1/organizations/{org}/folders|documents|uploads|trash|quota
// → files-worker over the FILES_WORKER service binding.
//
// The edge authenticates the caller (session or API key) and passes the actor
// down; files-worker decides what that actor may do in the org. Bodies stream
// through in both directions: an upload is a PDF of up to 95 MiB and content
// is a PDF stream, so neither is buffered here.
import type { Env } from "./env.js";
import { errorResponse, withEdgeTimings } from "./http.js";
import { replayOrExecute } from "./idempotency.js";
import { resolveActor } from "./resolve-actor.js";
import { createTimings } from "@saas/contracts/timing";

const FILES_RE = /^\/v1\/organizations\/[^/]+\/(?:folders|documents|uploads|trash|quota)(?:\/[^?#]*)?$/;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const WITH_BODY = new Set(["POST", "PUT", "PATCH"]);

const FORWARDED_HEADERS = [
  "content-type",
  "content-length",
  "traceparent",
  "idempotency-key",
  "if-none-match",
  "x-pagewell-base-version",
  "x-pagewell-page-count",
];

export function isFilesRoute(pathname: string): boolean {
  return FILES_RE.test(pathname);
}

export async function handleFilesRoute(request: Request, env: Env, requestId: string, pathname: string): Promise<Response> {
  if (!METHODS.has(request.method)) {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }

  return replayOrExecute(request, requestId, env, "files", async () => {
    if (!env.IDENTITY_WORKER) {
      return errorResponse("internal_error", "Authentication service unavailable", 503, requestId);
    }
    if (!env.FILES_WORKER) {
      return errorResponse("internal_error", "Files service unavailable", 503, requestId);
    }

    const timings = createTimings();
    const endTotal = timings.start("edge_total");
    const sessionResult = await timings.measure("edge_auth", () => resolveActor(request, env, requestId));
    if ("error" in sessionResult) {
      return sessionResult.error;
    }

    const headers = new Headers();
    headers.set("x-request-id", requestId);
    headers.set("x-actor-subject-id", sessionResult.subjectId);
    headers.set("x-actor-subject-type", sessionResult.subjectType);
    for (const name of FORWARDED_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }

    const url = new URL(request.url);
    const target = new URL(pathname + url.search, "https://files.internal");
    const init: RequestInit = { method: request.method, headers };
    if (WITH_BODY.has(request.method) && request.body) init.body = request.body;

    try {
      const downstream = await timings.measure("edge_downstream", () => env.FILES_WORKER!.fetch(target.toString(), init));
      const res = new Response(downstream.body, { status: downstream.status, headers: downstream.headers });
      endTotal();
      return withEdgeTimings(res, requestId, "edge.files", timings);
    } catch {
      return errorResponse("internal_error", "Files service unavailable", 503, requestId);
    }
  });
}
