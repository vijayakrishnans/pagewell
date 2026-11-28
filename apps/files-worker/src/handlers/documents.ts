import { BASE_VERSION_HEADER, SINGLE_UPLOAD_MAX_BYTES, type VersionConflictBody } from "@saas/contracts/files";
import type { Uuid } from "@saas/db/ids";
import { keyBelongsTo, r2Key } from "@saas/shared/r2-keys";
import { actorKindOf, pageCountOf, positiveInt, type Ctx } from "../context.js";
import { cleanName, fail, invalid, notFound, ok, readJson, unavailable } from "../http.js";
import { newUuid, toPublic } from "../ids.js";
import { publicDocument, publicVersion } from "../public.js";
import { check, limits, type Limits, type QuotaVerdict } from "../quota.js";
import { contentLength, storePdf, type StoreResult } from "../store.js";
import { canWriteInto, parentFrom } from "./drive.js";

const THUMB_MAX_BYTES = 512 * 1024;
const TEXT_MAX_BYTES = 8 * 1024 * 1024;

export function quotaExceeded(ctx: Ctx, verdict: Extract<QuotaVerdict, { ok: false }>): Response {
  const what = { file_size: "This file is larger than your plan allows", storage: "Your drive is full", versions: "This document has reached its version limit" }[verdict.which];
  return fail("quota_exceeded", what, 402, ctx.requestId, { quota: verdict.which, limit: verdict.limit });
}

export function refused(ctx: Ctx, r: Extract<StoreResult, { ok: false }>, l: Limits): Response {
  if (r.reason === "not_a_pdf") return fail("not_a_pdf", "Only PDF files can be stored", 415, ctx.requestId);
  if (r.reason === "empty") return invalid(ctx.requestId, { body: ["the PDF is empty"] });
  if (l.maxFileBytes !== null && SINGLE_UPLOAD_MAX_BYTES > l.maxFileBytes) {
    return quotaExceeded(ctx, { ok: false, which: "file_size", limit: l.maxFileBytes });
  }
  return fail("bad_request", "Too large for one request; use a multipart upload", 413, ctx.requestId);
}

/** The most one request may store, given the plan's file-size limit. */
export function singleRequestMax(l: Limits): number {
  return l.maxFileBytes === null ? SINGLE_UPLOAD_MAX_BYTES : Math.min(SINGLE_UPLOAD_MAX_BYTES, l.maxFileBytes);
}

/** POST /documents?name=&folderId= with the PDF as the body: a new document at version 1. */
export async function uploadDocument(ctx: Ctx, request: Request, url: URL): Promise<Response> {
  const name = cleanName(url.searchParams.get("name"));
  const folder = parentFrom(url.searchParams.get("folderId"));
  if (!name || !folder.ok) return invalid(ctx.requestId, { ...(name ? {} : { name: ["1–255 characters, no slashes"] }), ...(folder.ok ? {} : { folderId: ["not a folder id"] }) });
  if (!(await canWriteInto(ctx, folder.id))) return notFound(ctx.requestId);
  if (folder.id) {
    const f = await ctx.repo.getFolder(ctx.orgId, folder.id);
    if (!f.ok || f.value.deletedAt) return notFound(ctx.requestId);
  }
  const [l, usage] = await Promise.all([limits(ctx.env, ctx.orgPublic, ctx.requestId), ctx.repo.usage(ctx.orgId)]);
  if (!usage.ok) return unavailable(ctx.requestId);
  const declared = contentLength(request);
  const pre = check(l, { size: declared ?? 0, storageUsed: usage.value.storageBytes });
  if (!pre.ok) return quotaExceeded(ctx, pre);

  const docId = newUuid();
  const key = r2Key.blob(ctx.orgId, docId, newUuid());
  const stored = await storePdf(ctx.bucket, key, request.body, declared, singleRequestMax(l));
  if (!stored.ok) return refused(ctx, stored, l);
  const post = check(l, { size: stored.size, storageUsed: usage.value.storageBytes });
  if (!post.ok) {
    await ctx.bucket.delete(key);
    return quotaExceeded(ctx, post);
  }

  const r = await ctx.repo.createDocument({
    id: docId,
    orgId: ctx.orgId,
    folderId: folder.id,
    name,
    ownerUserId: ctx.actor.subjectId,
    actorKind: actorKindOf(ctx.actor),
    object: { r2Key: key, sha256: stored.sha256, size: stored.size, pageCount: pageCountOf(request) },
    now: ctx.now,
  });
  if (!r.ok) {
    await ctx.bucket.delete(key);
    return r.error.kind === "not_found" ? notFound(ctx.requestId) : unavailable(ctx.requestId);
  }
  await documentCreated(ctx, r.value.document.id as Uuid, name, folder.id);
  return ok({ document: publicDocument(r.value.document), version: publicVersion(r.value.version) }, ctx.requestId, 201);
}

export function documentCreated(ctx: Ctx, docId: Uuid, name: string, folderId: Uuid | null): Promise<void> {
  return ctx.audit.record("document.created", { kind: "document", id: docId, name }, `Uploaded "${name}"`, {
    documentId: toPublic("doc", docId),
    folderId: folderId ? toPublic("fld", folderId) : null,
  });
}

export async function listRecent(ctx: Ctx, url: URL): Promise<Response> {
  const limit = positiveInt(url.searchParams.get("limit"), 100) ?? 50;
  const r = await ctx.repo.listRecent(ctx.orgId, { limit, cursor: url.searchParams.get("cursor") });
  if (!r.ok) return r.error.kind === "internal" && r.error.message === "invalid cursor" ? invalid(ctx.requestId, { cursor: ["invalid"] }) : unavailable(ctx.requestId);
  return ok({ documents: r.value.items.map(publicDocument), nextCursor: r.value.nextCursor }, ctx.requestId, 200, r.value.nextCursor);
}

export async function getDocument(ctx: Ctx, docId: Uuid): Promise<Response> {
  const r = await ctx.repo.getDocument(ctx.orgId, docId);
  if (!r.ok) return r.error.kind === "not_found" ? notFound(ctx.requestId) : unavailable(ctx.requestId);
  return ok({ document: publicDocument(r.value) }, ctx.requestId);
}

export async function updateDocument(ctx: Ctx, request: Request, docId: Uuid): Promise<Response> {
  const body = await readJson(request);
  if (!body) return invalid(ctx.requestId, { body: ["a JSON object"] });
  const name = "name" in body ? cleanName(body.name) : undefined;
  const folder = "folderId" in body ? parentFrom(body.folderId) : undefined;
  if (name === null) return invalid(ctx.requestId, { name: ["1–255 characters, no slashes"] });
  if (folder && !folder.ok) return invalid(ctx.requestId, { folderId: ["not a folder id"] });
  if (folder?.ok && !(await canWriteInto(ctx, folder.id))) return notFound(ctx.requestId);
  let r = await ctx.repo.getDocument(ctx.orgId, docId);
  if (r.ok && r.value.deletedAt) return notFound(ctx.requestId);
  const oldName = r.ok ? r.value.name : "";
  if (r.ok && name !== undefined) {
    r = await ctx.repo.renameDocument(ctx.orgId, docId, name, ctx.now);
    if (r.ok) await ctx.audit.record("document.renamed", { kind: "document", id: docId, name }, `Renamed "${oldName}" to "${name}"`, { documentId: toPublic("doc", docId) });
  }
  if (r.ok && folder?.ok) {
    r = await ctx.repo.moveDocument(ctx.orgId, docId, folder.id, ctx.now);
    if (r.ok) await ctx.audit.record("document.moved", { kind: "document", id: docId, name: r.value.name }, `Moved "${r.value.name}"`, { documentId: toPublic("doc", docId), folderId: folder.id ? toPublic("fld", folder.id) : null });
  }
  if (!r.ok) return r.error.kind === "not_found" ? notFound(ctx.requestId) : unavailable(ctx.requestId);
  return ok({ document: publicDocument(r.value) }, ctx.requestId);
}

export async function trashDocument(ctx: Ctx, docId: Uuid): Promise<Response> {
  const before = await ctx.repo.getDocument(ctx.orgId, docId);
  const r = await ctx.repo.trashDocument(ctx.orgId, docId, ctx.now);
  if (!r.ok) return r.error.kind === "not_found" ? notFound(ctx.requestId) : unavailable(ctx.requestId);
  const name = before.ok ? before.value.name : null;
  await ctx.audit.record("document.deleted", { kind: "document", id: docId, name }, `Moved "${name ?? ""}" to the trash`, { documentId: toPublic("doc", docId) });
  return ok({ deletedAt: r.value.deletedAt.toISOString() }, ctx.requestId);
}

export async function restoreDocument(ctx: Ctx, docId: Uuid): Promise<Response> {
  const r = await ctx.repo.restoreDocument(ctx.orgId, docId, ctx.now);
  if (!r.ok) return r.error.kind === "not_found" ? notFound(ctx.requestId) : unavailable(ctx.requestId);
  await ctx.audit.record("document.restored", { kind: "document", id: docId, name: r.value.name }, `Restored "${r.value.name}" from the trash`, { documentId: toPublic("doc", docId) });
  return ok({ document: publicDocument(r.value) }, ctx.requestId);
}

export async function listVersions(ctx: Ctx, docId: Uuid): Promise<Response> {
  const doc = await ctx.repo.getDocument(ctx.orgId, docId);
  if (!doc.ok || doc.value.deletedAt) return notFound(ctx.requestId);
  const r = await ctx.repo.listVersions(ctx.orgId, docId);
  if (!r.ok) return r.error.kind === "not_found" ? notFound(ctx.requestId) : unavailable(ctx.requestId);
  return ok({ versions: r.value.map(publicVersion) }, ctx.requestId);
}

export function versionConflict(ctx: Ctx, currentVersion: number): Response {
  const body: { error: VersionConflictBody & { details: Record<string, unknown>; code: string; requestId: string } } = {
    error: {
      code: "version_conflict",
      error: "version_conflict",
      message: "Someone saved a newer version. Save as a copy or reload.",
      currentVersion,
      details: { currentVersion },
      requestId: ctx.requestId,
    },
  };
  return Response.json(body, { status: 409, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/** POST /documents/{doc}/versions with the whole PDF and X-Pagewell-Base-Version: a save. */
export async function saveVersion(ctx: Ctx, request: Request, docId: Uuid): Promise<Response> {
  const base = positiveInt(request.headers.get(BASE_VERSION_HEADER));
  if (!base) return invalid(ctx.requestId, { [BASE_VERSION_HEADER]: ["the version this save starts from"] });
  const doc = await ctx.repo.getDocument(ctx.orgId, docId);
  if (!doc.ok || doc.value.deletedAt) return notFound(ctx.requestId);
  if (doc.value.currentVersion !== base) return versionConflict(ctx, doc.value.currentVersion);

  const [l, usage] = await Promise.all([limits(ctx.env, ctx.orgPublic, ctx.requestId), ctx.repo.usage(ctx.orgId)]);
  if (!usage.ok) return unavailable(ctx.requestId);
  const declared = contentLength(request);
  const pre = check(l, { size: declared ?? 0, storageUsed: usage.value.storageBytes, versionsOfDoc: doc.value.currentVersion });
  if (!pre.ok) return quotaExceeded(ctx, pre);

  const key = r2Key.blob(ctx.orgId, docId, newUuid());
  const stored = await storePdf(ctx.bucket, key, request.body, declared, singleRequestMax(l));
  if (!stored.ok) return refused(ctx, stored, l);
  const post = check(l, { size: stored.size, storageUsed: usage.value.storageBytes, versionsOfDoc: doc.value.currentVersion });
  if (!post.ok) {
    await ctx.bucket.delete(key);
    return quotaExceeded(ctx, post);
  }
  return commitVersion(ctx, docId, base, { r2Key: key, sha256: stored.sha256, size: stored.size, pageCount: pageCountOf(request) }, null, true);
}

/** Record a version whose bytes are already in R2; on any refusal a fresh object is removed again. */
export async function commitVersion(
  ctx: Ctx,
  docId: Uuid,
  base: number,
  object: { r2Key: string; sha256: string; size: number; pageCount: number | null },
  restoredFrom: number | null,
  freshObject: boolean,
): Promise<Response> {
  const r = await ctx.repo.addVersion({
    orgId: ctx.orgId,
    docId,
    baseVersion: base,
    // eslint-disable-next-line no-restricted-syntax -- files_* actor columns are TEXT and keep the public actor id (usr_/sp_), so the kind survives
    createdBy: ctx.actor.subjectId,
    actorKind: actorKindOf(ctx.actor),
    object,
    restoredFrom,
    now: ctx.now,
  });
  if (r.ok) {
    const n = r.value.version.version;
    const name = r.value.document.name;
    await ctx.audit.record(
      restoredFrom ? "version.restored" : "version.created",
      { kind: "document", id: docId, name },
      restoredFrom ? `Restored version ${restoredFrom} of "${name}" as version ${n}` : `Saved version ${n} of "${name}"`,
      { documentId: toPublic("doc", docId), version: n, restoredFrom, size: object.size },
    );
    return ok({ document: publicDocument(r.value.document), version: publicVersion(r.value.version) }, ctx.requestId, 201);
  }
  if (freshObject) await ctx.bucket.delete(object.r2Key);
  if (r.error.kind === "version_conflict") return versionConflict(ctx, r.error.currentVersion);
  return r.error.kind === "not_found" ? notFound(ctx.requestId) : unavailable(ctx.requestId);
}

/** POST /documents/{doc}/versions/{n}/restore: version n's bytes become the next version. */
export async function restoreVersion(ctx: Ctx, request: Request, docId: Uuid, n: number): Promise<Response> {
  const doc = await ctx.repo.getDocument(ctx.orgId, docId);
  if (!doc.ok || doc.value.deletedAt) return notFound(ctx.requestId);
  const v = await ctx.repo.getVersion(ctx.orgId, docId, n);
  if (!v.ok) return notFound(ctx.requestId);
  const base = positiveInt(request.headers.get(BASE_VERSION_HEADER)) ?? doc.value.currentVersion;
  if (base !== doc.value.currentVersion) return versionConflict(ctx, doc.value.currentVersion);
  const l = await limits(ctx.env, ctx.orgPublic, ctx.requestId);
  // A restore stores no new bytes, so only the version count can be over.
  const verdict = check(l, { size: 0, storageUsed: 0, versionsOfDoc: doc.value.currentVersion });
  if (!verdict.ok) return quotaExceeded(ctx, verdict);
  const { r2Key: key, sha256, size, pageCount } = v.value;
  return commitVersion(ctx, docId, base, { r2Key: key, sha256, size, pageCount }, n, false);
}

/** GET /documents/{doc}/content?version=: the PDF, streamed from R2. */
export async function content(ctx: Ctx, request: Request, url: URL, docId: Uuid): Promise<Response> {
  const doc = await ctx.repo.getDocument(ctx.orgId, docId);
  if (!doc.ok || doc.value.deletedAt) return notFound(ctx.requestId);
  const asked = url.searchParams.get("version");
  const n = asked === null ? doc.value.currentVersion : positiveInt(asked);
  if (!n) return notFound(ctx.requestId);
  const v = await ctx.repo.getVersion(ctx.orgId, docId, n);
  if (!v.ok || !keyBelongsTo(v.value.r2Key, ctx.orgId)) return notFound(ctx.requestId);

  const etag = `"${v.value.sha256}"`;
  const headers = new Headers({
    "content-type": "application/pdf",
    etag,
    "x-pagewell-version": String(n),
    "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(doc.value.name)}`,
    // A numbered version never changes; "the current one" does.
    "cache-control": asked === null ? "private, no-cache" : "private, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
  });
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  const obj = await ctx.bucket.get(v.value.r2Key);
  if (!obj) return notFound(ctx.requestId);
  headers.set("content-length", String(obj.size));
  return new Response(request.method === "HEAD" ? null : obj.body, { status: 200, headers });
}

async function versionOf(ctx: Ctx, docId: Uuid, n: number) {
  const doc = await ctx.repo.getDocument(ctx.orgId, docId);
  if (!doc.ok || doc.value.deletedAt) return null;
  const v = await ctx.repo.getVersion(ctx.orgId, docId, n);
  return v.ok ? v.value : null;
}

/** PNG or WebP, by their magic bytes. */
function isImage(b: Uint8Array, type: string): boolean {
  if (type === "image/png") return b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v);
  if (type === "image/webp") return b.length >= 12 && String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP";
  return false;
}

async function boundedBytes(request: Request, max: number): Promise<Uint8Array | null> {
  const declared = contentLength(request);
  if (declared !== null && declared > max) return null;
  const bytes = new Uint8Array(await request.arrayBuffer());
  return bytes.byteLength > 0 && bytes.byteLength <= max ? bytes : null;
}

/** PUT /documents/{doc}/versions/{n}/thumbnail: the browser's render of page 1 (WebP or PNG). */
export async function putThumbnail(ctx: Ctx, request: Request, docId: Uuid, n: number): Promise<Response> {
  const type = (request.headers.get("content-type") ?? "").split(";")[0]!.trim();
  if (type !== "image/webp" && type !== "image/png") return fail("bad_request", "A thumbnail is image/webp or image/png", 415, ctx.requestId);
  if (!(await versionOf(ctx, docId, n))) return notFound(ctx.requestId);
  const bytes = await boundedBytes(request, THUMB_MAX_BYTES);
  if (!bytes) return fail("bad_request", "A thumbnail is at most 512 KiB", 413, ctx.requestId);
  // The bytes must be what the type says (PW-26): never store HTML or a script labelled an image.
  if (!isImage(bytes, type)) return fail("bad_request", "The thumbnail is not a PNG or WebP image", 415, ctx.requestId);
  await ctx.bucket.put(r2Key.thumb(ctx.orgId, docId, n, 1), bytes, { httpMetadata: { contentType: type } });
  return new Response(null, { status: 204 });
}

export async function getThumbnail(ctx: Ctx, docId: Uuid, n: number): Promise<Response> {
  if (!(await versionOf(ctx, docId, n))) return notFound(ctx.requestId);
  const obj = await ctx.bucket.get(r2Key.thumb(ctx.orgId, docId, n, 1));
  if (!obj) return notFound(ctx.requestId);
  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType ?? "image/webp",
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
}

/** PUT /documents/{doc}/versions/{n}/text: the text the browser extracted, for search and chat later. Never logged. */
export async function putText(ctx: Ctx, request: Request, docId: Uuid, n: number): Promise<Response> {
  const type = (request.headers.get("content-type") ?? "").split(";")[0]!.trim();
  if (type !== "application/json") return fail("bad_request", "Text is application/json", 415, ctx.requestId);
  if (!(await versionOf(ctx, docId, n))) return notFound(ctx.requestId);
  const bytes = await boundedBytes(request, TEXT_MAX_BYTES);
  if (!bytes) return fail("bad_request", "Text is at most 8 MiB", 413, ctx.requestId);
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
  } catch {
    return invalid(ctx.requestId, { body: ["JSON: {pages: [{page, text}]}"] });
  }
  await ctx.bucket.put(r2Key.text(ctx.orgId, docId, n), bytes, { httpMetadata: { contentType: "application/json" } });
  return new Response(null, { status: 204 });
}

