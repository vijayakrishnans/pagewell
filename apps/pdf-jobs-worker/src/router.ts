import { FILE_OPERATIONS, JOB_OPERATIONS, VERSIONING_OPERATIONS, type JobOperation, type JobOutputMode } from "@saas/contracts/jobs";
import { createSqlExecutor } from "@saas/db/d1";
import { createEventsRepository } from "@saas/db/events";
import { createJobsRepository, type Job, type JobsRepository } from "@saas/db/jobs";
import type { Uuid } from "@saas/db/ids";
import { keyBelongsTo } from "@saas/shared/r2-keys";
import { audit } from "./audit.js";
import { DriveError, driveFor, type Actor, type Drive } from "./drive.js";
import type { Env } from "./env.js";
import { fail, invalid, methodNotAllowed, notFound, ok, readJson, unavailable } from "./http.js";
import { fromPublic, generateRequestId, newUuid, toPublic } from "./ids.js";
import { jobLimits } from "./limits.js";
import { runnerAvailable } from "./runner.js";
import { dispatch as dispatchToRunner } from "./dispatch.js";

// The jobs API, behind api-edge (which authenticates and sets the actor headers), under
// /v1/organizations/{org}/jobs. What a person may run is what the drive lets them do: inputs
// must be readable, a new version needs write on the document, new documents need write where
// they go, all asked of files-worker as that person. Every miss is the same 404.
//
//   POST /jobs                         {operation, documentIds, version?, options?, output?} → 202
//   GET  /jobs?documentId=             a document's jobs (read on it), or the caller's own
//   GET  /jobs/{job}                   one job (its creator, or whoever may read its document)
//   POST /jobs/{job}/cancel            the creator, while it is still queued
//   GET  /jobs/{job}/files/{name}      a render, text or print result, for a day

const REQUEST_ID = /^[\w-]{1,128}$/;
const ORG_ROUTE = /^\/v1\/organizations\/([^/]+)\/jobs(\/.*)?$/;
const EMAIL = /^[^\s@]{1,200}@[^\s@]{1,200}$/;
const OPTIONS_MAX_BYTES = 4096;

export interface RouteDeps {
  /** Hand a new job to whatever runs it (the JobRunner Durable Object in the Worker). */
  dispatch?: (orgId: Uuid, jobId: Uuid) => Promise<boolean>;
}

function resolveActor(request: Request): Actor | null {
  const subjectId = request.headers.get("x-actor-subject-id");
  const subjectType = request.headers.get("x-actor-subject-type");
  if (!subjectId || !subjectType) return null;
  const email = request.headers.get("x-actor-email")?.trim().toLowerCase() ?? "";
  return { subjectId, subjectType, email: subjectType === "user" && EMAIL.test(email) ? email : null };
}

interface Ctx {
  env: Env;
  requestId: string;
  actor: Actor;
  orgId: Uuid;
  orgPublic: string;
  repo: JobsRepository;
  drive: Drive;
  now: Date;
  deps: RouteDeps;
  events: ReturnType<typeof createEventsRepository>;
}

/** Can the caller see this job: they made it, or they may read its first document. */
async function visible(ctx: Ctx, job: Job): Promise<boolean> {
  if (job.createdBy === ctx.actor.subjectId) return true;
  const first = job.inputs[0];
  return first ? (await ctx.drive.access("document", toPublic("doc", first.docId))) !== null : false;
}

async function createJob(ctx: Ctx, request: Request): Promise<Response> {
  const body = await readJson(request);
  const operation = JOB_OPERATIONS.find((o) => o === body?.operation) as JobOperation | undefined;
  const ids = Array.isArray(body?.documentIds) ? (body!.documentIds as unknown[]) : null;
  const docIds = ids?.map((d) => (typeof d === "string" ? fromPublic("doc", d) : null)) ?? null;
  const fields: Record<string, string[]> = {};
  if (!operation) fields.operation = [JOB_OPERATIONS.join(", ")];
  if (!docIds || docIds.some((d) => !d)) fields.documentIds = ["document ids (doc_…)"];
  else if (operation === "merge" ? docIds.length < 2 || docIds.length > 50 : docIds.length !== 1) fields.documentIds = [operation === "merge" ? "2 to 50 documents" : "exactly one document"];
  else if (new Set(docIds).size !== docIds.length) fields.documentIds = ["each document once"];
  const version = body?.version === undefined || body?.version === null ? null : body.version;
  if (version !== null && (!Number.isInteger(version) || (version as number) < 1 || (docIds?.length ?? 0) !== 1)) fields.version = ["a version number, for a single document"];
  const options = body?.options === undefined ? {} : body.options;
  if (!options || typeof options !== "object" || Array.isArray(options) || JSON.stringify(options).length > OPTIONS_MAX_BYTES) fields.options = ["an object"];
  let output: JobOutputMode | "files" = operation && FILE_OPERATIONS.includes(operation) ? "files" : operation && VERSIONING_OPERATIONS.includes(operation) ? "version" : "document";
  if (body?.output !== undefined) {
    if (!operation || !VERSIONING_OPERATIONS.includes(operation) || (body.output !== "version" && body.output !== "document")) fields.output = ["version or document, for ocr, compress, rotate, flatten, redact and sanitize"];
    else output = body.output as JobOutputMode;
  }
  if (Object.keys(fields).length || !operation || !docIds) return invalid(ctx.requestId, fields);
  if (!runnerAvailable(ctx.env)) return fail("runner_unavailable", "Heavy jobs are not available here yet", 503, ctx.requestId);

  // Read every input, as the caller (a 404 when they may not), and fix the versions now.
  const inputs = [];
  let firstFolder: string | null = null;
  for (const [i, id] of (docIds as Uuid[]).entries()) {
    const doc = await ctx.drive.document(toPublic("doc", id));
    if (doc.deletedAt) return notFound(ctx.requestId);
    if (i === 0) firstFolder = doc.folderId;
    const v = version ?? doc.currentVersion;
    if ((v as number) > doc.currentVersion) return invalid(ctx.requestId, { version: [`at most ${doc.currentVersion}`] });
    inputs.push({ docId: id, version: v as number });
  }
  if (output === "version") {
    const access = await ctx.drive.access("document", toPublic("doc", docIds[0]!));
    if (!access?.actions.includes("files.write")) return notFound(ctx.requestId);
  } else if (output === "document" && firstFolder) {
    const access = await ctx.drive.access("folder", firstFolder);
    if (!access?.actions.includes("files.write")) return notFound(ctx.requestId);
  }

  const limits = await jobLimits(ctx.env, ctx.orgPublic, ctx.requestId);
  const active = await ctx.repo.activeCount(ctx.orgId);
  if (!active.ok) return unavailable(ctx.requestId);
  if (active.value >= limits.concurrent) return fail("jobs_busy", `${limits.concurrent} jobs are already running; try again when one finishes`, 429, ctx.requestId);

  const created = await ctx.repo.create({
    id: newUuid(),
    orgId: ctx.orgId,
    operation,
    inputs,
    options: options as Record<string, unknown>,
    outputMode: output,
    // eslint-disable-next-line no-restricted-syntax -- jobs_jobs.created_by is TEXT and keeps the public actor id (usr_/sp_), so the job can act as that person
    createdBy: ctx.actor.subjectId,
    actorKind: ctx.actor.subjectType === "user" ? "user" : "api",
    actorEmail: ctx.actor.email,
    now: ctx.now,
  });
  if (!created.ok) return unavailable(ctx.requestId);
  const job = created.value;
  await audit({ events: ctx.events, requestId: ctx.requestId, now: () => ctx.now }, job, "job.created", `Started ${operation} on ${inputs.length} document(s)`, { jobId: toPublic("job", job.id) });
  const handed = await (ctx.deps.dispatch ?? ((o, j) => dispatchToRunner(ctx.env, o, j)))(ctx.orgId, job.id as Uuid);
  if (!handed) {
    await ctx.repo.fail(ctx.orgId, job.id as Uuid, "runner_unavailable", "The job could not be started", ctx.now);
    return fail("runner_unavailable", "The job could not be started", 503, ctx.requestId);
  }
  const { publicJob } = await import("./public.js");
  return ok({ job: publicJob(job) }, ctx.requestId, 202);
}

async function listJobs(ctx: Ctx, url: URL): Promise<Response> {
  const docParam = url.searchParams.get("documentId");
  const { publicJob } = await import("./public.js");
  if (docParam) {
    const docId = fromPublic("doc", docParam);
    if (!docId || !(await ctx.drive.access("document", docParam))) return notFound(ctx.requestId);
    const r = await ctx.repo.list(ctx.orgId, { docId, limit: 50 });
    return r.ok ? ok({ jobs: r.value.map(publicJob) }, ctx.requestId) : unavailable(ctx.requestId);
  }
  const r = await ctx.repo.list(ctx.orgId, { limit: 200 });
  if (!r.ok) return unavailable(ctx.requestId);
  return ok({ jobs: r.value.filter((j) => j.createdBy === ctx.actor.subjectId).slice(0, 50).map(publicJob) }, ctx.requestId);
}

async function getJob(ctx: Ctx, jobId: Uuid): Promise<Response> {
  const r = await ctx.repo.get(ctx.orgId, jobId);
  if (!r.ok || !(await visible(ctx, r.value))) return notFound(ctx.requestId);
  const { publicJob } = await import("./public.js");
  return ok({ job: publicJob(r.value) }, ctx.requestId);
}

async function cancelJob(ctx: Ctx, jobId: Uuid): Promise<Response> {
  const r = await ctx.repo.get(ctx.orgId, jobId);
  if (!r.ok || r.value.createdBy !== ctx.actor.subjectId) return notFound(ctx.requestId);
  const c = await ctx.repo.cancel(ctx.orgId, jobId, ctx.now);
  if (!c.ok) return fail("conflict", "The job has already started", 409, ctx.requestId);
  await audit({ events: ctx.events, requestId: ctx.requestId, now: () => ctx.now }, c.value, "job.canceled", `Canceled ${c.value.operation}`, { jobId: toPublic("job", jobId) });
  const { publicJob } = await import("./public.js");
  return ok({ job: publicJob(c.value) }, ctx.requestId);
}

async function jobFile(ctx: Ctx, jobId: Uuid, name: string): Promise<Response> {
  const r = await ctx.repo.get(ctx.orgId, jobId);
  if (!r.ok || !(await visible(ctx, r.value))) return notFound(ctx.requestId);
  const file = r.value.result?.files.find((f) => f.name === name);
  if (!file || !keyBelongsTo(file.r2Key, ctx.orgId) || !ctx.env.FILES_BUCKET) return notFound(ctx.requestId);
  const obj = await ctx.env.FILES_BUCKET.get(file.r2Key);
  if (!obj) return notFound(ctx.requestId);
  return new Response(obj.body, {
    headers: {
      "content-type": file.type,
      "content-length": String(obj.size),
      "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function route(request: Request, env: Env, now: Date = new Date(), deps: RouteDeps = {}): Promise<Response> {
  const url = new URL(request.url);
  const header = request.headers.get("x-request-id");
  const requestId = header && REQUEST_ID.test(header) ? header : generateRequestId();
  if (url.pathname === "/health" && request.method === "GET") {
    return ok({ ok: true, service: "pdf-jobs-worker", environment: env.ENVIRONMENT, runner: runnerAvailable(env) }, requestId);
  }
  const m = url.pathname.match(ORG_ROUTE);
  if (!m) return notFound(requestId);
  const orgId = fromPublic("org", m[1]);
  if (!orgId) return notFound(requestId);
  const rest = m[2] ?? "";

  type H = (ctx: Ctx) => Promise<Response>;
  let handler: H | null = null;
  let allowed: string[] = [];
  let sub: RegExpMatchArray | null;
  if (rest === "" || rest === "/") {
    allowed = ["GET", "POST"];
    handler = request.method === "POST" ? (ctx) => createJob(ctx, request) : request.method === "GET" ? (ctx) => listJobs(ctx, url) : null;
  } else if ((sub = rest.match(/^\/([^/]+)$/))) {
    const id = fromPublic("job", sub[1]);
    allowed = ["GET"];
    handler = id && request.method === "GET" ? (ctx) => getJob(ctx, id) : null;
    if (!id) return notFound(requestId);
  } else if ((sub = rest.match(/^\/([^/]+)\/cancel$/))) {
    const id = fromPublic("job", sub[1]);
    allowed = ["POST"];
    if (!id) return notFound(requestId);
    handler = request.method === "POST" ? (ctx) => cancelJob(ctx, id) : null;
  } else if ((sub = rest.match(/^\/([^/]+)\/files\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/))) {
    const id = fromPublic("job", sub[1]);
    const name = sub[2]!;
    allowed = ["GET"];
    if (!id) return notFound(requestId);
    handler = request.method === "GET" ? (ctx) => jobFile(ctx, id, name) : null;
  } else return notFound(requestId);
  if (!handler) return allowed.length ? methodNotAllowed(requestId) : notFound(requestId);

  const actor = resolveActor(request);
  if (!actor) return fail("unauthenticated", "Authentication required", 401, requestId);
  if (!env.PLATFORM_DB || !env.FILES_WORKER) return unavailable(requestId);
  const executor = createSqlExecutor(env.PLATFORM_DB as never);
  const orgPublic = toPublic("org", orgId);
  try {
    return await handler({
      env,
      requestId,
      actor,
      orgId,
      orgPublic,
      repo: createJobsRepository(executor),
      drive: driveFor(env, orgPublic, actor, requestId),
      now,
      deps,
      events: createEventsRepository(executor),
    });
  } catch (e) {
    if (e instanceof DriveError && e.status === 404) return notFound(requestId);
    console.error(JSON.stringify({ level: "error", msg: "pdf-jobs-worker request failed", requestId, error: e instanceof Error ? e.name : "unknown" }));
    return unavailable(requestId);
  } finally {
    await executor.dispose();
  }
}
