import { createSqlExecutor } from "@saas/db/d1";
import { createEventsRepository } from "@saas/db/events";
import { createSignRepository } from "@saas/db/sign";
import type { Uuid } from "@saas/db/ids";
import type { Env } from "./env.js";
import { record } from "./evidence.js";
import { complete, issueLinks, type FlowCtx } from "./flow.js";
import { toPublic } from "./ids.js";
import { notify } from "./notify.js";

// Hourly housekeeping (PW6): envelopes past their expiry end (links spent, signers told);
// signers due a reminder get a new link (the old one stops working); completions that waited
// for the runner, or failed on the way, are tried again. Counts only in the log.

export async function housekeeping(env: Env, now: Date = new Date()): Promise<{ expired: number; reminded: number; completed: number; waiting: number }> {
  const report = { expired: 0, reminded: 0, completed: 0, waiting: 0 };
  if (!env.PLATFORM_DB) return report;
  const executor = createSqlExecutor(env.PLATFORM_DB as never);
  const repo = createSignRepository(executor);
  const events = createEventsRepository(executor);
  const hour = now.toISOString().slice(0, 13);
  const ctxFor = (orgId: string, job: string): FlowCtx => ({ env, repo, orgId: orgId as Uuid, requestId: `req_sign_${job}_${hour.replace(/\D/g, "")}`, actor: { type: "system", id: `sign-${job}` }, now, events });
  try {
    const expired = await repo.expireDue(now, 100);
    for (const x of expired.ok ? expired.value : []) {
      report.expired++;
      await record(repo, x.orgId as Uuid, x.envelopeId as Uuid, "envelope.expired", {}, now);
      const e = await repo.getEnvelope(x.orgId as Uuid, x.envelopeId as Uuid);
      if (e.ok && e.value.senderEmail) await notify(env, ctxFor(x.orgId, "expiry"), "sign.voided", e.value.senderEmail, { title: e.value.title, from: e.value.senderEmail, reason: "The envelope expired before everyone signed." }, [toPublic("env", x.envelopeId), "expired"]);
    }
    const due = await repo.dueForReminder(now, 100);
    for (const { signer, envelope } of due.ok ? due.value : []) {
      const ctx = ctxFor(signer.orgId, "reminders");
      const sent = await issueLinks(ctx, envelope, [signer], "reminder");
      if (sent.length) {
        await repo.markReminded(signer.orgId as Uuid, signer.id as Uuid, now);
        report.reminded++;
      }
    }
    const stuck = await repo.stuckCompleting(new Date(now.getTime() - 5 * 60_000), 20);
    for (const e of stuck.ok ? stuck.value : []) {
      const outcome = await complete(ctxFor(e.orgId, "completion"), e.id as Uuid);
      if (outcome === "completed") report.completed++;
      else report.waiting++;
    }
  } finally {
    await executor.dispose();
  }
  return report;
}
