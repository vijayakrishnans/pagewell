import { createSqlExecutor } from "@saas/db/d1";
import { createEventsRepository } from "@saas/db/events";
import { createJobsRepository } from "@saas/db/jobs";
import type { Env } from "./env.js";
import type { ExecuteDeps } from "./execute.js";
import { driveFor } from "./drive.js";
import { toPublic } from "./ids.js";
import { jobLimits } from "./limits.js";
import { runnerFor } from "./runner.js";

/** Everything runJob needs, from the Worker's bindings. Dispose the executor afterwards. */
export function executeDepsFrom(env: Env, requestId: string): { deps: ExecuteDeps; dispose: () => Promise<void> } {
  const executor = createSqlExecutor(env.PLATFORM_DB as never);
  const deps: ExecuteDeps = {
    repo: createJobsRepository(executor),
    events: createEventsRepository(executor),
    bucket: env.FILES_BUCKET ?? null,
    runner: runnerFor(env),
    drive: (job) => driveFor(env, toPublic("org", job.orgId), { subjectId: job.createdBy, subjectType: job.actorKind === "user" ? "user" : "service_principal", email: job.actorEmail }, requestId),
    limits: (job) => jobLimits(env, toPublic("org", job.orgId), requestId),
    requestId,
    now: () => new Date(),
  };
  return { deps, dispose: () => executor.dispose() };
}
