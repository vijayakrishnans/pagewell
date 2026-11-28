// Pagewell's review (PW5) → review-worker over the REVIEW_WORKER service binding:
//   /v1/organizations/{org}/documents/{doc}/threads | review-requests | room/ticket,
//   /v1/organizations/{org}/threads/…, /v1/organizations/{org}/review-requests/… — signed in;
//   /v1/organizations/{org}/documents/{doc}/room — the DocRoom WebSocket, no session (a browser
//   cannot send one): the single-use ticket from room/ticket is the key, checked by the room.
import type { Env } from "./env.js";
import { errorResponse } from "./http.js";
import { replayOrExecute } from "./idempotency.js";
import { resolveActor } from "./resolve-actor.js";

const REVIEW_RE = /^\/v1\/organizations\/[^/]+\/(?:documents\/[^/]+\/(?:threads|review-requests|room\/ticket)|threads\/[^/]+(?:\/comments(?:\/[^/]+)?)?|review-requests\/[^/]+(?:\/decision)?)$/;
const ROOM_RE = /^\/v1\/organizations\/[^/]+\/documents\/[^/]+\/room$/;
const METHODS = new Set(["GET", "POST", "PATCH", "DELETE"]);

export function isReviewRoute(pathname: string): boolean {
  return REVIEW_RE.test(pathname);
}

export function isRoomRoute(pathname: string): boolean {
  return ROOM_RE.test(pathname);
}

/** The room's WebSocket upgrade, passed through untouched (a 101 must not be re-wrapped). */
export async function handleRoomRoute(request: Request, env: Env, requestId: string, pathname: string): Promise<Response> {
  if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return errorResponse("unsupported", "Expected a WebSocket upgrade", 426, requestId);
  }
  if (!env.REVIEW_WORKER) return errorResponse("internal_error", "Review service unavailable", 503, requestId);
  const url = new URL(request.url);
  const target = new URL(pathname, "https://review.internal");
  const ticket = url.searchParams.get("ticket");
  if (!ticket || !/^[A-Za-z0-9_-]{20,100}$/.test(ticket)) return errorResponse("not_found", "Not found", 404, requestId);
  target.searchParams.set("ticket", ticket);
  // Only what a WebSocket needs goes down: never a cookie or an Authorization header.
  const headers = new Headers({ "x-request-id": requestId });
  for (const name of ["upgrade", "connection", "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "sec-websocket-protocol", "origin"]) {
    const v = request.headers.get(name);
    if (v) headers.set(name, v);
  }
  return env.REVIEW_WORKER.fetch(target.toString(), { method: "GET", headers });
}

export async function handleReviewRoute(request: Request, env: Env, requestId: string, pathname: string): Promise<Response> {
  if (!METHODS.has(request.method)) return errorResponse("unsupported", "Method not allowed", 405, requestId);
  return replayOrExecute(request, requestId, env, "review", async () => {
    if (!env.IDENTITY_WORKER) return errorResponse("internal_error", "Authentication service unavailable", 503, requestId);
    if (!env.REVIEW_WORKER) return errorResponse("internal_error", "Review service unavailable", 503, requestId);
    const session = await resolveActor(request, env, requestId);
    if ("error" in session) return session.error;
    const headers = new Headers({ "x-request-id": requestId, "x-actor-subject-id": session.subjectId, "x-actor-subject-type": session.subjectType });
    if (session.email) headers.set("x-actor-email", session.email);
    for (const name of ["content-type", "content-length", "traceparent", "idempotency-key"]) {
      const v = request.headers.get(name);
      if (v) headers.set(name, v);
    }
    const url = new URL(request.url);
    const init: RequestInit = { method: request.method, headers };
    if ((request.method === "POST" || request.method === "PATCH") && request.body) init.body = request.body;
    try {
      const res = await env.REVIEW_WORKER.fetch(new URL(pathname + url.search, "https://review.internal").toString(), init);
      return new Response(res.body, { status: res.status, headers: res.headers });
    } catch {
      return errorResponse("internal_error", "Review service unavailable", 503, requestId);
    }
  });
}
