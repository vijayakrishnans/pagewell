// Pagewell's heavy jobs (PW4): /v1/organizations/{org}/jobs[/…] → pdf-jobs-worker over the
// JOBS_WORKER service binding. The edge authenticates the caller and passes the actor (and the
// verified email, which guest grants match) down; the jobs worker asks the drive what that
// person may do. Job bodies are small JSON; result files stream back untouched.
import type { Env } from "./env.js";
import { errorResponse, withEdgeTimings } from "./http.js";
import { replayOrExecute } from "./idempotency.js";
import { resolveActor } from "./resolve-actor.js";
import { createTimings } from "@saas/contracts/timing";

const JOBS_RE = /^\/v1\/organizations\/[^/]+\/jobs(?:\/[^?#]*)?$/;
const METHODS = new Set(["GET", "POST"]);
const FORWARDED_HEADERS = ["content-type", "content-length", "traceparent", "idempotency-key"];

export function isJobsRoute(pathname: string): boolean {
  return JOBS_RE.test(pathname);
}

export async function handleJobsRoute(request: Request, env: Env, requestId: string, pathname: string): Promise<Response> {
  if (!METHODS.has(request.method)) {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }
  return replayOrExecute(request, requestId, env, "jobs", async () => {
    if (!env.IDENTITY_WORKER) return errorResponse("internal_error", "Authentication service unavailable", 503, requestId);
    if (!env.JOBS_WORKER) return errorResponse("internal_error", "Jobs service unavailable", 503, requestId);
    const timings = createTimings();
    const endTotal = timings.start("edge_total");
    const sessionResult = await timings.measure("edge_auth", () => resolveActor(request, env, requestId));
    if ("error" in sessionResult) return sessionResult.error;

    const headers = new Headers();
    headers.set("x-request-id", requestId);
    headers.set("x-actor-subject-id", sessionResult.subjectId);
    headers.set("x-actor-subject-type", sessionResult.subjectType);
    if (sessionResult.email) headers.set("x-actor-email", sessionResult.email);
    for (const name of FORWARDED_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const url = new URL(request.url);
    const target = new URL(pathname + url.search, "https://jobs.internal");
    const init: RequestInit = { method: request.method, headers };
    if (request.method === "POST" && request.body) init.body = request.body;
    try {
      const downstream = await timings.measure("edge_downstream", () => env.JOBS_WORKER!.fetch(target.toString(), init));
      const res = new Response(downstream.body, { status: downstream.status, headers: downstream.headers });
      endTotal();
      return withEdgeTimings(res, requestId, "edge.jobs", timings);
    } catch {
      return errorResponse("internal_error", "Jobs service unavailable", 503, requestId);
    }
  });
}
