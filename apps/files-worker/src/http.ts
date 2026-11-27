import type { ErrorCode } from "@saas/contracts/errors";
import type { FilesErrorCode } from "@saas/contracts/files";

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };

export function ok<T>(data: T, requestId: string, status = 200, cursor: string | null = null): Response {
  return Response.json({ data, meta: { requestId, cursor } }, { status, headers: JSON_HEADERS });
}

export function fail(
  code: ErrorCode | FilesErrorCode,
  message: string,
  status: number,
  requestId: string,
  details?: Record<string, unknown>,
): Response {
  return Response.json({ error: { code, message, details: details ?? {}, requestId } }, { status, headers: JSON_HEADERS });
}

/** Another org's resource, a missing one, and one the caller may not see all look the same. */
export const notFound = (requestId: string) => fail("not_found", "Not found", 404, requestId);
export const unavailable = (requestId: string) => fail("internal_error", "Service unavailable", 503, requestId);
export const invalid = (requestId: string, fields: Record<string, string[]>) =>
  fail("validation_failed", "Validation failed", 422, requestId, { fields });
export const methodNotAllowed = (requestId: string) => fail("unsupported", "Method not allowed", 405, requestId);

/** A drive name: 1–255 characters, no control characters, no slashes. */
export function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.normalize("NFC").trim();
  if (name.length < 1 || name.length > 255 || /[\u0000-\u001f\u007f/\\]/.test(name)) return null;
  return name;
}

export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
