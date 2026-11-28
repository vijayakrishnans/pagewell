import { SINGLE_UPLOAD_MAX_BYTES, UPLOAD_PART_BYTES, UPLOAD_TTL_HOURS } from "@saas/contracts/files";
import type { Uuid } from "@saas/db/ids";
import type { Upload } from "@saas/db/files";
import { r2Key } from "@saas/shared/r2-keys";
import { actorKindOf, positiveInt, type Ctx } from "../context.js";
import { cleanName, fail, invalid, notFound, ok, readJson, unavailable } from "../http.js";
import { fromPublic, newUuid, toPublic } from "../ids.js";
import { publicDocument, publicVersion } from "../public.js";
import { check, limits } from "../quota.js";
import { digestObject, looksLikePdf } from "../store.js";
import { canWriteInto, parentFrom } from "./drive.js";
import { commitVersion, documentCreated, quotaExceeded, versionConflict } from "./documents.js";

// Multipart uploads, for files too big for one request. The target document id
// is decided when the upload starts (the object key carries it): a new
// document when base_version is NULL, else the next version of doc_id.

const MAX_PARTS = 10_000;
const SHA256 = /^[0-9a-f]{64}$/;

const mpu = (ctx: Ctx, u: Upload) => ctx.bucket.resumeMultipartUpload(u.r2Key, u.r2UploadId);

/** POST /uploads {name, folderId?, docId?, baseVersion?, size}. */
export async function createUpload(ctx: Ctx, request: Request): Promise<Response> {
  const body = await readJson(request);
  const name = cleanName(body?.name);
  const folder = parentFrom(body?.folderId);
  const size = typeof body?.size === "number" && Number.isSafeInteger(body.size) && body.size > 0 ? body.size : null;
  const existing = body?.docId === undefined || body?.docId === null ? null : fromPublic("doc", String(body.docId));
  const base = existing ? (typeof body?.baseVersion === "number" ? positiveInt(String(body.baseVersion)) : null) : null;
  const fields: Record<string, string[]> = {};
  if (!name) fields.name = ["1–255 characters, no slashes"];
  if (!folder.ok) fields.folderId = ["not a folder id"];
  if (!size) fields.size = ["the file's size in bytes"];
  if (body?.docId !== undefined && body?.docId !== null && !existing) fields.docId = ["not a document id"];
  if (existing && !base) fields.baseVersion = ["the version this save starts from"];
  if (Object.keys(fields).length || !name || !folder.ok || !size) return invalid(ctx.requestId, fields);
  const allowed = existing ? await ctx.access.can("files.write", { kind: "document", id: existing }) : await canWriteInto(ctx, folder.id);
  if (!allowed) return notFound(ctx.requestId);

  let versionsOfDoc: number | undefined;
  if (existing) {
    const doc = await ctx.repo.getDocument(ctx.orgId, existing);
    if (!doc.ok || doc.value.deletedAt) return notFound(ctx.requestId);
    if (doc.value.currentVersion !== base) return versionConflict(ctx, doc.value.currentVersion);
    versionsOfDoc = doc.value.currentVersion;
  } else if (folder.id) {
    const f = await ctx.repo.getFolder(ctx.orgId, folder.id);
    if (!f.ok || f.value.deletedAt) return notFound(ctx.requestId);
  }
  const [l, usage] = await Promise.all([limits(ctx.env, ctx.orgPublic, ctx.requestId), ctx.repo.usage(ctx.orgId)]);
  if (!usage.ok) return unavailable(ctx.requestId);
  const verdict = check(l, { size, storageUsed: usage.value.storageBytes, versionsOfDoc });
  if (!verdict.ok) return quotaExceeded(ctx, verdict);

  const uploadId = newUuid();
  const docId = existing ?? newUuid();
  const key = r2Key.blob(ctx.orgId, docId, uploadId);
  const started = await ctx.bucket.createMultipartUpload(key, { httpMetadata: { contentType: "application/pdf" } });
  const expiresAt = new Date(ctx.now.getTime() + UPLOAD_TTL_HOURS * 3_600_000);
  const r = await ctx.repo.createUpload({
    id: uploadId,
    orgId: ctx.orgId,
    docId,
    folderId: existing ? null : folder.id,
    name,
    r2Key: key,
    r2UploadId: started.uploadId,
    baseVersion: base,
    // eslint-disable-next-line no-restricted-syntax -- files_* actor columns are TEXT and keep the public actor id (usr_/sp_), so the kind survives
    createdBy: ctx.actor.subjectId,
    now: ctx.now,
    expiresAt,
  });
  if (!r.ok) {
    await started.abort().catch(() => undefined);
    return unavailable(ctx.requestId);
  }
  return ok({ upload: { id: toPublic("upl", uploadId), partSize: UPLOAD_PART_BYTES, expiresAt: expiresAt.toISOString() } }, ctx.requestId, 201);
}

/** An open upload, to the person who started it only, while they may still write where it goes. */
async function openUpload(ctx: Ctx, uploadId: Uuid): Promise<Upload | null> {
  const r = await ctx.repo.getUpload(ctx.orgId, uploadId);
  if (!r.ok || r.value.completedAt || r.value.expiresAt <= ctx.now) return null;
  if (r.value.createdBy !== ctx.actor.subjectId) return null;
  const u = r.value;
  const allowed = u.baseVersion !== null && u.docId ? await ctx.access.can("files.write", { kind: "document", id: u.docId as Uuid }) : await canWriteInto(ctx, u.folderId as Uuid | null);
  return allowed ? u : null;
}

/** PUT /uploads/{upl}/parts/{n} with the part's bytes. Part 1 must start the PDF. */
export async function putPart(ctx: Ctx, request: Request, uploadId: Uuid, n: number): Promise<Response> {
  if (n > MAX_PARTS) return notFound(ctx.requestId);
  const u = await openUpload(ctx, uploadId);
  if (!u) return notFound(ctx.requestId);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > SINGLE_UPLOAD_MAX_BYTES) return fail("bad_request", "A part is 1 byte to 95 MiB", 413, ctx.requestId);
  if (n === 1 && !looksLikePdf(bytes.subarray(0, 1024))) return fail("not_a_pdf", "Only PDF files can be stored", 415, ctx.requestId);
  const part = await mpu(ctx, u).uploadPart(n, bytes);
  const r = await ctx.repo.recordUploadPart(ctx.orgId, uploadId, { partNumber: part.partNumber, etag: part.etag });
  if (!r.ok) return r.error.kind === "not_found" ? notFound(ctx.requestId) : unavailable(ctx.requestId);
  return ok({ partNumber: part.partNumber }, ctx.requestId);
}

/** POST /uploads/{upl}/complete {sha256, pageCount?}: the object is checked, then becomes a document or a version. */
export async function completeUpload(ctx: Ctx, request: Request, uploadId: Uuid): Promise<Response> {
  const body = await readJson(request);
  const sha256 = typeof body?.sha256 === "string" && SHA256.test(body.sha256) ? body.sha256 : null;
  if (!sha256) return invalid(ctx.requestId, { sha256: ["the file's sha256, lower-case hex"] });
  const pageCount = typeof body?.pageCount === "number" ? positiveInt(String(body.pageCount)) : null;
  const u = await openUpload(ctx, uploadId);
  if (!u || u.parts.length === 0 || !u.docId) return notFound(ctx.requestId);

  await mpu(ctx, u).complete(u.parts);
  const discard = async () => {
    await ctx.bucket.delete(u.r2Key);
    await ctx.repo.forgetUpload(ctx.orgId, uploadId);
  };
  const stored = await digestObject(ctx.bucket, u.r2Key);
  if (!stored) {
    await ctx.repo.forgetUpload(ctx.orgId, uploadId);
    return unavailable(ctx.requestId);
  }
  if (stored.sha256 !== sha256) {
    await discard();
    return invalid(ctx.requestId, { sha256: ["does not match the uploaded bytes"] });
  }
  const docId = u.docId as Uuid;
  const [l, usage] = await Promise.all([limits(ctx.env, ctx.orgPublic, ctx.requestId), ctx.repo.usage(ctx.orgId)]);
  if (!usage.ok) return unavailable(ctx.requestId);
  let versionsOfDoc: number | undefined;
  if (u.baseVersion !== null) {
    const doc = await ctx.repo.getDocument(ctx.orgId, docId);
    versionsOfDoc = doc.ok ? doc.value.currentVersion : undefined;
  }
  const verdict = check(l, { size: stored.size, storageUsed: usage.value.storageBytes, versionsOfDoc });
  if (!verdict.ok) {
    await discard();
    return quotaExceeded(ctx, verdict);
  }
  const object = { r2Key: u.r2Key, sha256, size: stored.size, pageCount };

  if (u.baseVersion !== null) {
    const res = await commitVersion(ctx, docId, u.baseVersion, object, null, true);
    if (res.status === 201) await ctx.repo.completeUpload(ctx.orgId, uploadId, ctx.now);
    else await ctx.repo.forgetUpload(ctx.orgId, uploadId);
    return res;
  }
  const r = await ctx.repo.createDocument({
    id: docId,
    orgId: ctx.orgId,
    folderId: u.folderId as Uuid | null,
    name: u.name,
    ownerUserId: ctx.actor.subjectId,
    actorKind: actorKindOf(ctx.actor),
    object,
    now: ctx.now,
  });
  if (!r.ok) {
    await discard();
    return r.error.kind === "not_found" ? notFound(ctx.requestId) : unavailable(ctx.requestId);
  }
  await ctx.repo.completeUpload(ctx.orgId, uploadId, ctx.now);
  await documentCreated(ctx, docId, u.name, u.folderId as Uuid | null);
  return ok({ document: publicDocument(r.value.document), version: publicVersion(r.value.version) }, ctx.requestId, 201);
}

/** DELETE /uploads/{upl}: give up; R2 drops the parts. */
export async function abortUpload(ctx: Ctx, uploadId: Uuid): Promise<Response> {
  const u = await openUpload(ctx, uploadId);
  if (!u) return notFound(ctx.requestId);
  await mpu(ctx, u).abort().catch(() => undefined);
  await ctx.repo.forgetUpload(ctx.orgId, uploadId);
  return new Response(null, { status: 204 });
}
