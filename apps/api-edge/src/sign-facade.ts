// Pagewell's e-sign (PW6) → sign-worker over the SIGN_WORKER service binding:
//   /v1/organizations/{org}/envelopes[/{env}[/send|resend|void|evidence]] — signed in;
//   /v1/s/{token}[/code|verify|submit|decline|documents/{doc}] — the signer's, no session: the
//   link token is the key, checked in sign-worker. Rate-limited per IP (family "sign").
import type { Env } from "./env.js";
import { errorResponse } from "./http.js";
import { replayOrExecute } from "./idempotency.js";
import { resolveActor } from "./resolve-actor.js";

const ENVELOPE_RE = /^\/v1\/organizations\/[^/]+\/envelopes(?:\/[^/]+(?:\/(?:send|resend|void|evidence))?)?$/;
const SIGNING_RE = /^\/v1\/s\/[A-Za-z0-9_-]{20,100}(?:\/(?:code|verify|submit|decline)|\/documents\/doc_[0-9a-f]{32})?$/;
const METHODS = new Set(["GET", "POST", "PATCH"]);
const SIGNING_HEADERS = ["content-type", "content-length", "user-agent", "cf-connecting-ip", "traceparent"];
const SIGNING_BODY_MAX = 2 * 1024 * 1024;

export function isEnvelopeRoute(pathname: string): boolean {
  return ENVELOPE_RE.test(pathname);
}

export function isSigningRoute(pathname: string): boolean {
  return SIGNING_RE.test(pathname);
}

async function forward(env: Env, requestId: string, pathname: string, search: string, init: RequestInit): Promise<Response> {
  if (!env.SIGN_WORKER) return errorResponse("internal_error", "Signing service unavailable", 503, requestId);
  try {
    const res = await env.SIGN_WORKER.fetch(new URL(pathname + search, "https://sign.internal").toString(), init);
    return new Response(res.body, { status: res.status, headers: res.headers });
  } catch {
    return errorResponse("internal_error", "Signing service unavailable", 503, requestId);
  }
}

export async function handleEnvelopeRoute(request: Request, env: Env, requestId: string, pathname: string): Promise<Response> {
  if (!METHODS.has(request.method)) return errorResponse("unsupported", "Method not allowed", 405, requestId);
  return replayOrExecute(request, requestId, env, "sign", async () => {
    if (!env.IDENTITY_WORKER) return errorResponse("internal_error", "Authentication service unavailable", 503, requestId);
    const session = await resolveActor(request, env, requestId);
    if ("error" in session) return session.error;
    const headers = new Headers({ "x-request-id": requestId, "x-actor-subject-id": session.subjectId, "x-actor-subject-type": session.subjectType });
    if (session.email) headers.set("x-actor-email", session.email);
    for (const name of ["content-type", "content-length", "traceparent", "idempotency-key"]) {
      const v = request.headers.get(name);
      if (v) headers.set(name, v);
    }
    const init: RequestInit = { method: request.method, headers };
    if ((request.method === "POST" || request.method === "PATCH") && request.body) init.body = request.body;
    return forward(env, requestId, pathname, new URL(request.url).search, init);
  });
}

export async function handleSigningRoute(request: Request, env: Env, requestId: string, pathname: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") return errorResponse("unsupported", "Method not allowed", 405, requestId);
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > SIGNING_BODY_MAX) return errorResponse("bad_request", "The request is too large", 413, requestId);
  return replayOrExecute(request, requestId, env, "sign", async () => {
    // Only what the signer's page needs goes down: never a cookie or an Authorization header.
    const headers = new Headers({ "x-request-id": requestId });
    for (const name of SIGNING_HEADERS) {
      const v = request.headers.get(name);
      if (v) headers.set(name, v);
    }
    const init: RequestInit = { method: request.method, headers };
    if (request.method === "POST" && request.body) init.body = request.body;
    return forward(env, requestId, pathname, "", init);
  });
}
