import { createSqlExecutor } from "@saas/db/d1";
import { createJobsRepository } from "@saas/db/jobs";
import type { Uuid } from "@saas/db/ids";
import { keyBelongsTo } from "@saas/shared/r2-keys";
import type { Env } from "./env.js";

// Housekeeping: a job running for longer than the longest run allowed lost its runner and is
// failed; result files past their day are removed. Counts only in the log.

const STALE_MINUTES = 20;

export async function sweep(env: Env, now: Date = new Date()): Promise<{ lost: number; filesRemoved: number }> {
  if (!env.PLATFORM_DB) return { lost: 0, filesRemoved: 0 };
  const executor = createSqlExecutor(env.PLATFORM_DB as never);
  const repo = createJobsRepository(executor);
  let lost = 0;
  let filesRemoved = 0;
  try {
    const stale = await repo.stale(new Date(now.getTime() - STALE_MINUTES * 60_000), 100);
    for (const j of stale.ok ? stale.value : []) {
      const r = await repo.fail(j.orgId as Uuid, j.id as Uuid, "runner_lost", "The job stopped answering; run it again", now);
      if (r.ok) lost++;
    }
    const expired = await repo.expired(now, 100);
    for (const j of expired.ok ? expired.value : []) {
      const keys = (j.result?.files ?? []).map((f) => f.r2Key).filter((k) => keyBelongsTo(k, j.orgId));
      if (keys.length && env.FILES_BUCKET) await env.FILES_BUCKET.delete(keys);
      filesRemoved += keys.length;
      await repo.clearFiles(j.orgId as Uuid, j.id as Uuid);
    }
  } finally {
    await executor.dispose();
  }
  return { lost, filesRemoved };
}
