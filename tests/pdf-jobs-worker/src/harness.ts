// pdf-jobs-worker over the REAL files-worker: one SQLite engine with every migration (D1 is
// SQLite), one in-memory R2, the real policy engine; the jobs worker reaches the drive through
// files-worker's own router as the person a job acts for. The pdf-runner container is a fake
// that answers its protocol (containers/pdf-runner/server.mjs).
import { route as filesRoute } from "@files-worker/router";
import { route as jobsRoute } from "@jobs-worker/router";
import { runJob, type ExecuteDeps, type Outcome } from "@jobs-worker/execute";
import { driveFor } from "@jobs-worker/drive";
import { jobLimits } from "@jobs-worker/limits";
import { RunnerError, type Runner, type RunnerOutput } from "@jobs-worker/runner";
import { toPublic } from "@jobs-worker/ids";
import type { Env as JobsEnv } from "@jobs-worker/env";
import { createSqlExecutor } from "@saas/db/d1";
import { createEventsRepository } from "@saas/db/events";
import { createJobsRepository } from "@saas/db/jobs";
import type { Uuid } from "@saas/db/ids";
import { fixturePdf, world as filesWorld, type World as FilesWorld } from "../../files-worker/src/harness.js";

export { fixturePdf };

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

/** A pdf-runner stand-in: what each operation returns, and failures to inject. */
export class FakeRunner implements Runner {
  calls: Array<{ operation: string; options: Record<string, unknown>; limits: Record<string, number>; inputs: number[] }> = [];
  failures: RunnerError[] = [];
  async run(job: { operation: string; options: Record<string, unknown>; limits: Record<string, number> }, inputs: Uint8Array[]) {
    this.calls.push({ ...job, inputs: inputs.map((b) => b.byteLength) });
    const next = this.failures.shift();
    if (next) throw next;
    const pdf = (n: number, tag: string): RunnerOutput => ({ name: "result.pdf", type: "application/pdf", bytes: fixturePdf(n, `${job.operation} ${tag}`) });
    let outputs: RunnerOutput[];
    switch (job.operation) {
      case "split":
        outputs = [1, 2].map((i) => ({ name: `part-${i}.pdf`, type: "application/pdf", bytes: fixturePdf(1, `part ${i}`) }));
        break;
      case "render":
        outputs = ((job.options.pages as number[] | undefined) ?? [1]).map((p) => ({ name: `page-${p}.png`, type: "image/png", bytes: PNG }));
        break;
      case "text":
        outputs = [{ name: "text.json", type: "application/json", bytes: new TextEncoder().encode(JSON.stringify({ pages: [{ page: 1, text: "Generated" }] })) }];
        break;
      default:
        outputs = [pdf(job.operation === "merge" ? inputs.length * 2 : 2, "out")];
    }
    return { outputs, pages: 2 * inputs.length };
  }
}

export interface JobsWorld {
  files: FilesWorld;
  env: JobsEnv;
  runner: FakeRunner;
  queued: Array<{ orgId: Uuid; jobId: Uuid }>;
  request(method: string, path: string, init?: { user?: string; email?: string; json?: unknown }): Promise<Response>;
  /** Run every captured job once; returns their outcomes. */
  runQueued(): Promise<Outcome[]>;
  run(orgId: Uuid, jobId: Uuid): Promise<Outcome>;
}

export function jobsWorld(limits: Record<string, number | null> = {}, opts: { runner?: boolean } = {}): JobsWorld {
  const files = filesWorld(limits);
  const filesFetcher = {
    fetch: (input: string | Request, init?: RequestInit) => filesRoute(input instanceof Request ? input : new Request(input, init), files.env, files.now),
  } as unknown as Fetcher;
  const env: JobsEnv = {
    ENVIRONMENT: "test",
    PLATFORM_DB: files.env.PLATFORM_DB!,
    FILES_BUCKET: files.env.FILES_BUCKET!,
    FILES_WORKER: filesFetcher,
    BILLING_WORKER: files.env.BILLING_WORKER!,
    ...(opts.runner === false ? {} : { RUNNER_URL: "http://runner.test" }),
  };
  const runner = new FakeRunner();
  const queued: JobsWorld["queued"] = [];
  const deps = (): ExecuteDeps => {
    const executor = createSqlExecutor(env.PLATFORM_DB as never);
    return {
      repo: createJobsRepository(executor),
      events: createEventsRepository(executor),
      bucket: env.FILES_BUCKET ?? null,
      runner: opts.runner === false ? null : runner,
      drive: (job) => driveFor(env, toPublic("org", job.orgId), { subjectId: job.createdBy, subjectType: "user", email: job.actorEmail }, "req_job"),
      limits: (job) => jobLimits(env, toPublic("org", job.orgId), "req_job"),
      requestId: "req_job",
      now: () => files.now,
    };
  };
  const w: JobsWorld = {
    files,
    env,
    runner,
    queued,
    async request(method, path, init = {}) {
      const headers: Record<string, string> = {};
      if (init.user) {
        headers["x-actor-subject-id"] = init.user;
        headers["x-actor-subject-type"] = "user";
        if (init.email) headers["x-actor-email"] = init.email;
      }
      let body: string | null = null;
      if (init.json !== undefined) {
        body = JSON.stringify(init.json);
        headers["content-type"] = "application/json";
      }
      return jobsRoute(new Request(`http://jobs${path}`, { method, headers, body }), env, files.now, {
        dispatch: async (orgId, jobId) => {
          queued.push({ orgId, jobId });
          return true;
        },
      });
    },
    async runQueued() {
      const out: Outcome[] = [];
      while (queued.length) {
        const { orgId, jobId } = queued.shift()!;
        out.push(await runJob(deps(), orgId, jobId));
      }
      return out;
    },
    run: (orgId, jobId) => runJob(deps(), orgId, jobId),
  };
  return w;
}
