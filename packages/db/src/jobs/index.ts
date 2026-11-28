import type { SqlExecutor, SqlRow } from "../d1/executor.js";
import type { Uuid } from "../ids/index.js";

// Pagewell's heavy jobs (PW4). Every statement names org_id except the two housekeeping reads
// (stale running jobs, expired result files), which work across orgs and hand back rows that
// carry their org. A job moves queued → running → succeeded | failed (or queued → canceled);
// each move is conditional on the state it leaves, so two runners never both take a job.

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";
export type JobOutputMode = "version" | "document" | "files";

export interface JobInput {
  docId: string;
  version: number;
}

export interface JobResult {
  documents: Array<{ docId: string; version: number }>;
  files: Array<{ name: string; type: string; size: number; r2Key: string }>;
}

export interface Job {
  id: string;
  orgId: string;
  operation: string;
  status: JobStatus;
  inputs: JobInput[];
  options: Record<string, unknown>;
  outputMode: JobOutputMode;
  result: JobResult | null;
  errorCode: string | null;
  errorMessage: string | null;
  pages: number | null;
  attempts: number;
  createdBy: string;
  actorKind: "user" | "agent" | "mcp" | "api";
  actorEmail: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  expiresAt: Date | null;
}

export type JobsResult<T> = { ok: true; value: T } | { ok: false; error: { kind: "not_found" } | { kind: "conflict" } | { kind: "internal"; message: string } };

export interface CreateJobInput {
  id: Uuid;
  orgId: Uuid;
  operation: string;
  inputs: JobInput[];
  options: Record<string, unknown>;
  outputMode: JobOutputMode;
  createdBy: string;
  actorKind: Job["actorKind"];
  actorEmail: string | null;
  now: Date;
}

export interface JobsRepository {
  create(input: CreateJobInput): Promise<JobsResult<Job>>;
  get(orgId: Uuid, jobId: Uuid): Promise<JobsResult<Job>>;
  /** Newest first; optionally only the jobs that read a document. */
  list(orgId: Uuid, query: { docId?: Uuid | null; limit: number }): Promise<JobsResult<Job[]>>;
  /** Queued or running jobs in the org, for the concurrency limit. */
  activeCount(orgId: Uuid): Promise<JobsResult<number>>;
  /** queued → running, once; counts the attempt. Not found when another runner took it. */
  start(orgId: Uuid, jobId: Uuid, now: Date): Promise<JobsResult<Job>>;
  /** running → succeeded with what it made. */
  succeed(orgId: Uuid, jobId: Uuid, result: JobResult, pages: number | null, now: Date, expiresAt: Date | null): Promise<JobsResult<Job>>;
  /** running (or queued) → failed with a bounded code and message. */
  fail(orgId: Uuid, jobId: Uuid, code: string, message: string, now: Date): Promise<JobsResult<Job>>;
  /** running → queued again, for a retry after a transient failure. */
  requeue(orgId: Uuid, jobId: Uuid): Promise<JobsResult<Job>>;
  /** queued → canceled. Not found once it started. */
  cancel(orgId: Uuid, jobId: Uuid, now: Date): Promise<JobsResult<Job>>;
  /** Housekeeping: jobs running since before `before` (their runner died), across orgs. */
  stale(before: Date, limit: number): Promise<JobsResult<Job[]>>;
  /** Housekeeping: succeeded jobs whose result files expired, across orgs; their files are cleared. */
  expired(now: Date, limit: number): Promise<JobsResult<Job[]>>;
  clearFiles(orgId: Uuid, jobId: Uuid): Promise<JobsResult<void>>;
}

const date = (v: unknown) => new Date(v as string);
const dateOrNull = (v: unknown) => (v ? new Date(v as string) : null);
const iso = (d: Date) => d.toISOString();
const parse = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== "string") return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};

function mapJob(r: SqlRow): Job {
  return {
    id: r.id as string,
    orgId: r.org_id as string,
    operation: r.operation as string,
    status: r.status as JobStatus,
    inputs: parse<JobInput[]>(r.inputs_json, []),
    options: parse<Record<string, unknown>>(r.options_json, {}),
    outputMode: r.output_mode as JobOutputMode,
    result: parse<JobResult | null>(r.result_json, null),
    errorCode: (r.error_code as string | null) ?? null,
    errorMessage: (r.error_message as string | null) ?? null,
    pages: r.pages === null || r.pages === undefined ? null : Number(r.pages),
    attempts: Number(r.attempts ?? 0),
    createdBy: r.created_by as string,
    actorKind: r.actor_kind as Job["actorKind"],
    actorEmail: (r.actor_email as string | null) ?? null,
    createdAt: date(r.created_at),
    startedAt: dateOrNull(r.started_at),
    finishedAt: dateOrNull(r.finished_at),
    expiresAt: dateOrNull(r.expires_at),
  };
}

const fail = (message: string): JobsResult<never> => ({ ok: false, error: { kind: "internal", message } });
const notFound: JobsResult<never> = { ok: false, error: { kind: "not_found" } };

export function createJobsRepository(executor: SqlExecutor): JobsRepository {
  const rows = async (text: string, params: unknown[]) => (await executor.execute(text, params)).rows;
  const one = async (text: string, params: unknown[]) => (await rows(text, params))[0];
  const update = async (text: string, params: unknown[], what: string): Promise<JobsResult<Job>> => {
    try {
      const row = await one(text, params);
      return row ? { ok: true, value: mapJob(row) } : notFound;
    } catch {
      return fail(`Failed to ${what}`);
    }
  };

  return {
    async create(input) {
      try {
        const row = await one(
          `INSERT INTO jobs_jobs (id, org_id, operation, inputs_json, options_json, output_mode, created_by, actor_kind, actor_email, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
          [input.id, input.orgId, input.operation, JSON.stringify(input.inputs), JSON.stringify(input.options), input.outputMode, input.createdBy, input.actorKind, input.actorEmail, iso(input.now)],
        );
        return row ? { ok: true, value: mapJob(row) } : fail("Failed to create job");
      } catch {
        return fail("Failed to create job");
      }
    },
    get: (orgId, jobId) => update(`SELECT * FROM jobs_jobs WHERE org_id = $1 AND id = $2`, [orgId, jobId], "get job"),
    async list(orgId, query) {
      try {
        const result = query.docId
          ? await rows(
              `SELECT j.* FROM jobs_jobs j WHERE j.org_id = $1
                 AND EXISTS (SELECT 1 FROM json_each(j.inputs_json) e WHERE json_extract(e.value, '$.docId') = $2)
               ORDER BY j.created_at DESC, j.id DESC LIMIT $3`,
              [orgId, query.docId, query.limit],
            )
          : await rows(`SELECT * FROM jobs_jobs WHERE org_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`, [orgId, query.limit]);
        return { ok: true, value: result.map(mapJob) };
      } catch {
        return fail("Failed to list jobs");
      }
    },
    async activeCount(orgId) {
      try {
        const row = await one(`SELECT count(*) AS n FROM jobs_jobs WHERE org_id = $1 AND status IN ('queued', 'running')`, [orgId]);
        return { ok: true, value: Number(row?.n ?? 0) };
      } catch {
        return fail("Failed to count jobs");
      }
    },
    start: (orgId, jobId, now) =>
      update(
        `UPDATE jobs_jobs SET status = 'running', started_at = $3, attempts = attempts + 1
          WHERE org_id = $1 AND id = $2 AND status = 'queued' RETURNING *`,
        [orgId, jobId, iso(now)],
        "start job",
      ),
    succeed: (orgId, jobId, result, pages, now, expiresAt) =>
      update(
        `UPDATE jobs_jobs SET status = 'succeeded', result_json = $3, pages = $4, finished_at = $5, expires_at = $6, error_code = NULL, error_message = NULL
          WHERE org_id = $1 AND id = $2 AND status = 'running' RETURNING *`,
        [orgId, jobId, JSON.stringify(result), pages, iso(now), expiresAt ? iso(expiresAt) : null],
        "finish job",
      ),
    fail: (orgId, jobId, code, message, now) =>
      update(
        `UPDATE jobs_jobs SET status = 'failed', error_code = $3, error_message = $4, finished_at = $5
          WHERE org_id = $1 AND id = $2 AND status IN ('queued', 'running') RETURNING *`,
        [orgId, jobId, code.slice(0, 64), message.slice(0, 500), iso(now)],
        "fail job",
      ),
    requeue: (orgId, jobId) =>
      update(`UPDATE jobs_jobs SET status = 'queued' WHERE org_id = $1 AND id = $2 AND status = 'running' RETURNING *`, [orgId, jobId], "requeue job"),
    cancel: (orgId, jobId, now) =>
      update(
        `UPDATE jobs_jobs SET status = 'canceled', finished_at = $3 WHERE org_id = $1 AND id = $2 AND status = 'queued' RETURNING *`,
        [orgId, jobId, iso(now)],
        "cancel job",
      ),
    async stale(before, limit) {
      try {
        const result = await rows(`SELECT * FROM jobs_jobs WHERE status = 'running' AND started_at < $1 ORDER BY started_at LIMIT $2`, [iso(before), limit]);
        return { ok: true, value: result.map(mapJob) };
      } catch {
        return fail("Failed to read stale jobs");
      }
    },
    async expired(now, limit) {
      try {
        const result = await rows(`SELECT * FROM jobs_jobs WHERE expires_at IS NOT NULL AND expires_at <= $1 ORDER BY expires_at LIMIT $2`, [iso(now), limit]);
        return { ok: true, value: result.map(mapJob) };
      } catch {
        return fail("Failed to read expired jobs");
      }
    },
    async clearFiles(orgId, jobId) {
      try {
        await executor.execute(
          `UPDATE jobs_jobs SET expires_at = NULL, result_json = json_set(COALESCE(result_json, '{}'), '$.files', json('[]')) WHERE org_id = $1 AND id = $2`,
          [orgId, jobId],
        );
        return { ok: true, value: undefined };
      } catch {
        return fail("Failed to clear job files");
      }
    },
  };
}
