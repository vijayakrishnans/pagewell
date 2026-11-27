/**
 * Pagewell's drive in the console (PW2): pure helpers, dependency-free so they
 * are unit-testable (tests/web-console-next/src/drive.test.ts).
 *
 * Opening a document hands the editor a session. The editor runs on its own
 * origin (apps/editor-web) and cannot read the console's storage, so Open
 * opens the editor in a new tab and, when that tab says hello, posts it the
 * bearer token and the API base: to the editor's origin only, to that window
 * only, once. The token never goes into a URL (no history, no logs, no
 * Referer).
 */

import type { AppConfig } from "./app-config";

/** Largest file sent in one request; above it the SDK's multipart upload is used. */
export const SINGLE_REQUEST_MAX = 95 * 1024 * 1024;

export const HELLO = "pagewell:hello";
export const SESSION = "pagewell:session";

export interface HandoffMessage {
  type: typeof SESSION;
  token: string;
  apiBase: string;
  orgId: string;
}

/** The editor's origin for an environment: `https://<prefix>-<env>.<subdomain>.workers.dev`. */
export function editorOrigin(config: Pick<AppConfig, "editorWorkerPrefix" | "workersDevSubdomain">, environment: string): string {
  return `https://${config.editorWorkerPrefix}-${environment}.${config.workersDevSubdomain}.workers.dev`;
}

/** Where Open sends the user: the document id and org id only (neither is a secret). */
export function editorUrl(origin: string, orgId: string, docId: string): string {
  const url = new URL(`/edit/${encodeURIComponent(docId)}`, origin);
  url.searchParams.set("org", orgId);
  return url.toString();
}

/**
 * The reply to a message the console receives while an editor tab is opening:
 * the session, but only for a hello from the editor's origin and from the
 * window the console opened. Anything else gets nothing.
 */
export function handoffReply(
  event: { origin: string; source: unknown; data: unknown },
  expected: { origin: string; window: unknown; token: string | null; apiBase: string; orgId: string },
): HandoffMessage | null {
  if (!expected.token) return null;
  if (event.origin !== expected.origin) return null;
  if (event.source === null || event.source !== expected.window) return null;
  const data = event.data as { type?: unknown } | null;
  if (!data || typeof data !== "object" || data.type !== HELLO) return null;
  return { type: SESSION, token: expected.token, apiBase: expected.apiBase, orgId: expected.orgId };
}

/** 1536 → "1.5 KB". */
export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}

/** How full the drive is, 0–100, or null when the plan is unlimited. */
export function usagePercent(used: number, limit: number | null): number | null {
  if (limit === null) return null;
  if (limit <= 0) return 100;
  return Math.min(100, Math.round((used / limit) * 100));
}

/** Which files of a drop or a picker the drive takes: PDFs only, by type or by name. */
export function pdfFiles<T extends { name: string; type: string }>(files: Iterable<T>): { accepted: T[]; rejected: T[] } {
  const accepted: T[] = [];
  const rejected: T[] = [];
  for (const f of files) {
    if (f.type === "application/pdf" || /\.pdf$/i.test(f.name)) accepted.push(f);
    else rejected.push(f);
  }
  return { accepted, rejected };
}

/** One request, or the multipart flow. */
export function uploadMode(size: number): "single" | "multipart" {
  return size > SINGLE_REQUEST_MAX ? "multipart" : "single";
}

/** When a trashed item is removed for good, in words. */
export function purgeIn(purgeAt: string, now: Date = new Date()): string {
  const days = Math.ceil((new Date(purgeAt).getTime() - now.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  return days === 1 ? "in 1 day" : `in ${days} days`;
}
