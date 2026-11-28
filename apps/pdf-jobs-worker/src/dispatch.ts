import type { Uuid } from "@saas/db/ids";
import type { Env } from "./env.js";
import { executeDepsFrom } from "./deps.js";
import { runJob } from "./execute.js";
import { generateRequestId } from "./ids.js";

// One Durable Object per job (named by the job id). POST /start stores the job and sets an alarm
// for now; the alarm runs it. A runner that could not be reached gets up to MAX_ATTEMPTS tries,
// backing off; after that the job fails. This stands in for a Cloudflare Queue, which the
// workspace's deploy token cannot create (WAITING W4): Workers Scripts covers Durable Objects.

const MAX_ATTEMPTS = 3;

interface Stored {
  orgId: Uuid;
  jobId: Uuid;
  tries: number;
}

export class JobRunner implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/start") return new Response("not found", { status: 404 });
    const body = (await request.json()) as Partial<Stored>;
    if (typeof body.orgId !== "string" || typeof body.jobId !== "string") return new Response("bad request", { status: 400 });
    if (await this.state.storage.get("job")) return new Response(null, { status: 202 }); // already started
    await this.state.storage.put("job", { orgId: body.orgId, jobId: body.jobId, tries: 0 } satisfies Stored);
    await this.state.storage.setAlarm(Date.now());
    return new Response(null, { status: 202 });
  }

  async alarm(): Promise<void> {
    const job = await this.state.storage.get<Stored>("job");
    if (!job) return;
    const { deps, dispose } = executeDepsFrom(this.env, generateRequestId());
    try {
      const outcome = await runJob(deps, job.orgId, job.jobId);
      if (outcome === "retry" && job.tries + 1 < MAX_ATTEMPTS) {
        await this.state.storage.put("job", { ...job, tries: job.tries + 1 });
        await this.state.storage.setAlarm(Date.now() + 15_000 * 2 ** job.tries);
        return;
      }
      if (outcome === "retry") await deps.repo.fail(job.orgId, job.jobId, "runner_unavailable", "The PDF runner could not be reached; try again later", new Date());
      await this.state.storage.deleteAll();
    } finally {
      await dispose();
    }
  }
}

/** Hand a new job to its Durable Object. */
export async function dispatch(env: Env, orgId: Uuid, jobId: Uuid): Promise<boolean> {
  if (!env.JOB_RUNNER) return false;
  const stub = env.JOB_RUNNER.get(env.JOB_RUNNER.idFromName(jobId));
  const res = await stub.fetch("https://job-runner/start", { method: "POST", body: JSON.stringify({ orgId, jobId }) });
  return res.status === 202;
}
