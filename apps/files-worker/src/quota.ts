import { FILES_ENTITLEMENTS, FILES_FREE_TIER, type FilesQuota } from "@saas/contracts/files";
import type { CheckBillingEntitlementResponse } from "@saas/contracts/billing";
import type { Env } from "./env.js";

// Limits come from the org's billing entitlements (quantity, null = unlimited).
// A key the plan does not configure, or billing being unreachable, falls back
// to the free tier: never to unlimited. A key configured but disabled is 0.

export interface Limits {
  storageBytes: number | null;
  maxFileBytes: number | null;
  versionsPerDocument: number | null;
}

async function limitFor(env: Env, orgPublicId: string, key: string, fallback: number, requestId: string): Promise<number | null> {
  if (!env.BILLING_WORKER) return fallback;
  try {
    const res = await env.BILLING_WORKER.fetch("http://billing-worker/v1/internal/billing/entitlements/check", {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": requestId, "x-internal-caller": "files-worker" },
      body: JSON.stringify({ orgId: orgPublicId, entitlementKey: key }),
    });
    if (!res.ok) return fallback;
    const decision = ((await res.json()) as { data?: CheckBillingEntitlementResponse }).data;
    if (!decision || typeof decision.allowed !== "boolean") return fallback;
    if (!decision.allowed) return decision.reason === "disabled" ? 0 : fallback;
    if (decision.valueType !== "quantity") return fallback;
    if (decision.limitValue === null) return null;
    return Number.isFinite(decision.limitValue) && decision.limitValue >= 0 ? decision.limitValue : fallback;
  } catch {
    return fallback;
  }
}

export async function limits(env: Env, orgPublicId: string, requestId: string): Promise<Limits> {
  const [storageBytes, maxFileBytes, versionsPerDocument] = await Promise.all([
    limitFor(env, orgPublicId, FILES_ENTITLEMENTS.STORAGE_BYTES, FILES_FREE_TIER.storageBytes, requestId),
    limitFor(env, orgPublicId, FILES_ENTITLEMENTS.MAX_FILE_BYTES, FILES_FREE_TIER.maxFileBytes, requestId),
    limitFor(env, orgPublicId, FILES_ENTITLEMENTS.VERSIONS_PER_DOCUMENT, FILES_FREE_TIER.versionsPerDocument, requestId),
  ]);
  return { storageBytes, maxFileBytes, versionsPerDocument };
}

export type QuotaVerdict = { ok: true } | { ok: false; which: "file_size" | "storage" | "versions"; limit: number };

/** Would writing `size` more bytes (and, for a save, one more version) stay within the limits? */
export function check(l: Limits, use: { size: number; storageUsed: number; versionsOfDoc?: number | undefined }): QuotaVerdict {
  if (l.maxFileBytes !== null && use.size > l.maxFileBytes) return { ok: false, which: "file_size", limit: l.maxFileBytes };
  if (l.storageBytes !== null && use.storageUsed + use.size > l.storageBytes) return { ok: false, which: "storage", limit: l.storageBytes };
  if (use.versionsOfDoc !== undefined && l.versionsPerDocument !== null && use.versionsOfDoc + 1 > l.versionsPerDocument) {
    return { ok: false, which: "versions", limit: l.versionsPerDocument };
  }
  return { ok: true };
}

export function toPublicQuota(l: Limits, storageUsed: number): FilesQuota {
  return {
    storageBytes: { used: storageUsed, limit: l.storageBytes },
    maxFileBytes: l.maxFileBytes,
    maxVersionsPerDocument: l.versionsPerDocument,
  };
}
