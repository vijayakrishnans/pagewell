import type { FilesRepository } from "@saas/db/files";
import type { Uuid } from "@saas/db/ids";
import { PAGE_COUNT_HEADER } from "@saas/contracts/files";
import type { Actor } from "./auth.js";
import type { Env } from "./env.js";

/** Everything a handler needs for one request in one org. */
export interface Ctx {
  env: Env;
  requestId: string;
  actor: Actor;
  orgId: Uuid;
  orgPublic: string;
  repo: FilesRepository;
  bucket: R2Bucket;
  now: Date;
}

/** Who a stored version is attributed to. */
export function actorKindOf(actor: Actor): "user" | "api" {
  return actor.subjectType === "user" ? "user" : "api";
}

/** The browser's page count for a PDF body, when it sent a sane one. */
export function pageCountOf(request: Request): number | null {
  const v = request.headers.get(PAGE_COUNT_HEADER);
  if (!v || !/^\d{1,6}$/.test(v)) return null;
  const n = Number(v);
  return n >= 1 ? n : null;
}

/** A positive integer path or header value, or null. */
export function positiveInt(value: string | null | undefined, max = 1_000_000): number | null {
  if (!value || !/^\d{1,9}$/.test(value)) return null;
  const n = Number(value);
  return n >= 1 && n <= max ? n : null;
}
