import type { FolderListingResponse } from "@saas/contracts/files";
import type { Uuid } from "@saas/db/ids";
import type { Ctx } from "../context.js";
import { cleanName, fail, invalid, notFound, ok, readJson, unavailable } from "../http.js";
import { fromPublic, toPublic } from "../ids.js";
import { publicDocument, publicFolder, publicTrashEntry } from "../public.js";
import { limits, toPublicQuota } from "../quota.js";

const BREADCRUMB_DEPTH = 32;

/** GET /folders (the org root) and GET /folders/{fld}: what the drive shows. */
export async function listFolder(ctx: Ctx, folderId: Uuid | null): Promise<Response> {
  const listing = await ctx.repo.listFolder(ctx.orgId, folderId);
  if (!listing.ok) return listing.error.kind === "not_found" ? notFound(ctx.requestId) : unavailable(ctx.requestId);

  let folder = null;
  let chain: Array<{ id: string; name: string }> = [];
  if (folderId) {
    let cursor: Uuid | null = folderId;
    for (let depth = 0; cursor && depth < BREADCRUMB_DEPTH; depth++) {
      const f = await ctx.repo.getFolder(ctx.orgId, cursor);
      if (!f.ok) break;
      if (depth === 0) folder = publicFolder(f.value);
      chain.unshift({ id: f.value.id, name: f.value.name });
      cursor = f.value.parentId as Uuid | null;
    }
    // A guest sees the path from the highest folder shared with them down, never above it.
    if (ctx.access.principal === "guest") {
      const granted = new Set((await ctx.access.myGrants({ kind: "folder", id: folderId })).filter((g) => g.resourceKind === "folder").map((g) => g.resourceId));
      const top = chain.findIndex((c) => granted.has(c.id));
      chain = top >= 0 ? chain.slice(top) : chain.slice(-1);
    }
  }
  const breadcrumb: FolderListingResponse["breadcrumb"] = chain.map((c) => ({ id: toPublic("fld", c.id), name: c.name }));
  const body: FolderListingResponse = {
    folder,
    breadcrumb,
    folders: listing.value.folders.map(publicFolder),
    documents: listing.value.documents.map(publicDocument),
  };
  return ok(body, ctx.requestId);
}

/** May the caller add to this folder (or, for null, to the org's root)? */
export async function canWriteInto(ctx: Ctx, folderId: Uuid | null): Promise<boolean> {
  return folderId ? ctx.access.can("files.write", { kind: "folder", id: folderId }) : ctx.access.org("files.write");
}

/** A folder id from the wire: absent or null is the root; anything malformed is invalid. */
export function parentFrom(value: unknown): { ok: true; id: Uuid | null } | { ok: false } {
  if (value === undefined || value === null || value === "") return { ok: true, id: null };
  const id = typeof value === "string" ? fromPublic("fld", value) : null;
  return id ? { ok: true, id } : { ok: false };
}

export async function createFolder(ctx: Ctx, request: Request, newId: Uuid): Promise<Response> {
  const body = await readJson(request);
  const name = cleanName(body?.name);
  const parent = parentFrom(body?.parentId);
  if (!name || !parent.ok) return invalid(ctx.requestId, { ...(name ? {} : { name: ["1–255 characters, no slashes"] }), ...(parent.ok ? {} : { parentId: ["not a folder id"] }) });
  if (!(await canWriteInto(ctx, parent.id))) return notFound(ctx.requestId);
  // eslint-disable-next-line no-restricted-syntax -- files_* actor columns are TEXT and keep the public actor id (usr_/sp_), so the kind survives
  const r = await ctx.repo.createFolder({ id: newId, orgId: ctx.orgId, parentId: parent.id, name, createdBy: ctx.actor.subjectId, now: ctx.now });
  if (r.ok) {
    await ctx.audit.record("folder.created", { kind: "folder", id: r.value.id, name }, `Created folder "${name}"`, { folderId: toPublic("fld", r.value.id), parentId: parent.id ? toPublic("fld", parent.id) : null });
    return ok({ folder: publicFolder(r.value) }, ctx.requestId, 201);
  }
  if (r.error.kind === "conflict") return fail("conflict", "A folder with that name is already here", 409, ctx.requestId);
  if (r.error.kind === "not_found") return notFound(ctx.requestId);
  return unavailable(ctx.requestId);
}

export async function updateFolder(ctx: Ctx, request: Request, folderId: Uuid): Promise<Response> {
  const body = await readJson(request);
  if (!body) return invalid(ctx.requestId, { body: ["a JSON object"] });
  let latest = null;
  if ("name" in body) {
    const name = cleanName(body.name);
    if (!name) return invalid(ctx.requestId, { name: ["1–255 characters, no slashes"] });
    const r = await ctx.repo.renameFolder(ctx.orgId, folderId, name, ctx.now);
    if (!r.ok) {
      if (r.error.kind === "conflict") return fail("conflict", "A folder with that name is already here", 409, ctx.requestId);
      return r.error.kind === "not_found" ? notFound(ctx.requestId) : unavailable(ctx.requestId);
    }
    latest = r.value;
    await ctx.audit.record("folder.renamed", { kind: "folder", id: folderId, name }, `Renamed a folder to "${name}"`, { folderId: toPublic("fld", folderId) });
  }
  if ("parentId" in body) {
    const parent = parentFrom(body.parentId);
    if (!parent.ok) return invalid(ctx.requestId, { parentId: ["not a folder id"] });
    if (!(await canWriteInto(ctx, parent.id))) return notFound(ctx.requestId);
    const r = await ctx.repo.moveFolder(ctx.orgId, folderId, parent.id, ctx.now);
    if (!r.ok) {
      if (r.error.kind === "invalid_move") return fail("invalid_move", "A folder cannot go inside itself", 422, ctx.requestId);
      if (r.error.kind === "conflict") return fail("conflict", "A folder with that name is already there", 409, ctx.requestId);
      return r.error.kind === "not_found" ? notFound(ctx.requestId) : unavailable(ctx.requestId);
    }
    latest = r.value;
    await ctx.audit.record("folder.moved", { kind: "folder", id: folderId, name: r.value.name }, `Moved folder "${r.value.name}"`, { folderId: toPublic("fld", folderId), parentId: parent.id ? toPublic("fld", parent.id) : null });
  }
  if (!latest) {
    const r = await ctx.repo.getFolder(ctx.orgId, folderId);
    if (!r.ok || r.value.deletedAt) return notFound(ctx.requestId);
    latest = r.value;
  }
  return ok({ folder: publicFolder(latest) }, ctx.requestId);
}

export async function trashFolder(ctx: Ctx, folderId: Uuid): Promise<Response> {
  const before = await ctx.repo.getFolder(ctx.orgId, folderId);
  const r = await ctx.repo.trashFolder(ctx.orgId, folderId, ctx.now);
  if (!r.ok) return r.error.kind === "not_found" ? notFound(ctx.requestId) : unavailable(ctx.requestId);
  const name = before.ok ? before.value.name : null;
  await ctx.audit.record("folder.deleted", { kind: "folder", id: folderId, name }, `Moved folder "${name ?? ""}" and everything in it to the trash`, { folderId: toPublic("fld", folderId) });
  return ok({ deletedAt: r.value.deletedAt.toISOString() }, ctx.requestId);
}

export async function restoreFolder(ctx: Ctx, folderId: Uuid): Promise<Response> {
  const r = await ctx.repo.restoreFolder(ctx.orgId, folderId, ctx.now);
  if (r.ok) {
    await ctx.audit.record("folder.restored", { kind: "folder", id: folderId, name: r.value.name }, `Restored folder "${r.value.name}" from the trash`, { folderId: toPublic("fld", folderId) });
    return ok({ folder: publicFolder(r.value) }, ctx.requestId);
  }
  if (r.error.kind === "conflict") return fail("conflict", "A folder with that name is already there; rename it first", 409, ctx.requestId);
  return r.error.kind === "not_found" ? notFound(ctx.requestId) : unavailable(ctx.requestId);
}

export async function listTrash(ctx: Ctx): Promise<Response> {
  const r = await ctx.repo.listTrash(ctx.orgId);
  if (!r.ok) return unavailable(ctx.requestId);
  return ok({ entries: r.value.map(publicTrashEntry) }, ctx.requestId);
}

export async function quota(ctx: Ctx): Promise<Response> {
  const [l, usage] = await Promise.all([limits(ctx.env, ctx.orgPublic, ctx.requestId), ctx.repo.usage(ctx.orgId)]);
  if (!usage.ok) return unavailable(ctx.requestId);
  return ok({ quota: toPublicQuota(l, usage.value.storageBytes) }, ctx.requestId);
}
