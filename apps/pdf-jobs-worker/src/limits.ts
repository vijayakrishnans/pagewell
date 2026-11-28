import { JOBS_ENTITLEMENTS, JOBS_FREE_TIER } from "@saas/contracts/jobs";
import type { CheckBillingEntitlementResponse } from "@saas/contracts/billing";
import type { Env } from "./env.js";

// Per-plan job limits from the org's billing entitlements (quantity). A key the plan does not
// set, or billing being unreachable, gets the free tier, never unlimited; null (unlimited) is
// still capped by the runner's own hard ceilings.

export interface JobLimits {
  pagesPerJob: number;
  concurrent: number;
  cpuSecondsPerJob: number;
  memoryMb: number;
  wallSeconds: number;
}

const CEILING = { pagesPerJob: 2000, concurrent: 20, cpuSecondsPerJob: 300 };

async function limitFor(env: Env, orgPublicId: string, key: string, fallback: number, ceiling: number, requestId: string): Promise<number> {
  if (!env.BILLING_WORKER) return fallback;
  try {
    const res = await env.BILLING_WORKER.fetch("http://billing-worker/v1/internal/billing/entitlements/check", {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": requestId, "x-internal-caller": "pdf-jobs-worker" },
      body: JSON.stringify({ orgId: orgPublicId, entitlementKey: key }),
    });
    if (!res.ok) return fallback;
    const d = ((await res.json()) as { data?: CheckBillingEntitlementResponse }).data;
    if (!d || typeof d.allowed !== "boolean") return fallback;
    if (!d.allowed) return d.reason === "disabled" ? 0 : fallback;
    if (d.valueType !== "quantity") return fallback;
    if (d.limitValue === null) return ceiling;
    return Number.isFinite(d.limitValue) && d.limitValue >= 0 ? Math.min(d.limitValue, ceiling) : fallback;
  } catch {
    return fallback;
  }
}

export async function jobLimits(env: Env, orgPublicId: string, requestId: string): Promise<JobLimits> {
  const [pagesPerJob, concurrent, cpuSecondsPerJob] = await Promise.all([
    limitFor(env, orgPublicId, JOBS_ENTITLEMENTS.pagesPerJob, JOBS_FREE_TIER.pagesPerJob, CEILING.pagesPerJob, requestId),
    limitFor(env, orgPublicId, JOBS_ENTITLEMENTS.concurrent, JOBS_FREE_TIER.concurrent, CEILING.concurrent, requestId),
    limitFor(env, orgPublicId, JOBS_ENTITLEMENTS.cpuSecondsPerJob, JOBS_FREE_TIER.cpuSecondsPerJob, CEILING.cpuSecondsPerJob, requestId),
  ]);
  return { pagesPerJob, concurrent, cpuSecondsPerJob, memoryMb: JOBS_FREE_TIER.memoryMb, wallSeconds: Math.max(JOBS_FREE_TIER.wallSeconds, cpuSecondsPerJob * 2) };
}
