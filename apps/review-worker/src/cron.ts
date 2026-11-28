import { createSqlExecutor } from "@saas/db/d1";
import { createReviewRepository } from "@saas/db/review";
import type { Uuid } from "@saas/db/ids";
import type { Env } from "./env.js";
import { toPublic } from "./ids.js";
import { notify } from "./notify.js";

// Daily: remind reviewers who have not decided, for open requests due within a day (or overdue),
// at most once a day each. Counts only in the log.

const DAY = 86_400_000;

export async function remind(env: Env, now: Date = new Date()): Promise<{ requests: number; emails: number }> {
  if (!env.PLATFORM_DB) return { requests: 0, emails: 0 };
  const executor = createSqlExecutor(env.PLATFORM_DB as never);
  const repo = createReviewRepository(executor);
  let emails = 0;
  let requests = 0;
  try {
    const due = await repo.dueForReminder(now, DAY, new Date(now.getTime() - DAY + 60_000), 100);
    for (const r of due.ok ? due.value : []) {
      requests++;
      const day = now.toISOString().slice(0, 10);
      const openUrl = env.EDITOR_URL && /^https:\/\/[^\s/]+$/.test(env.EDITOR_URL) ? `${env.EDITOR_URL}/edit/${toPublic("doc", r.docId)}?org=${toPublic("org", r.orgId)}` : null;
      for (const v of r.reviewers.filter((x) => !x.decision)) {
        await notify(env, { orgId: r.orgId, actor: { type: "system", id: "review-reminders" }, requestId: `req_remind_${day}` }, "review.reminder", v.email, { dueAt: r.dueAt?.toISOString() ?? null, overdue: Boolean(r.dueAt && r.dueAt < now), openUrl }, [toPublic("rvr", r.id), v.email.replace(/[^A-Za-z0-9._-]/g, "_"), day]);
        emails++;
      }
      await repo.markReminded(r.orgId as Uuid, r.id as Uuid, now);
    }
  } finally {
    await executor.dispose();
  }
  return { requests, emails };
}
