import type { Document, Folder, TrashEntry, Version } from "@saas/db/files";
import type { PublicDocument, PublicFolder, PublicTrashEntry, PublicVersion } from "@saas/contracts/files";
import { TRASH_RETENTION_DAYS } from "@saas/contracts/files";
import { toPublic } from "./ids.js";

// Database rows → wire shapes. R2 keys never leave the worker.

const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);

export function publicFolder(f: Folder): PublicFolder {
  return {
    id: toPublic("fld", f.id),
    orgId: toPublic("org", f.orgId),
    parentId: f.parentId ? toPublic("fld", f.parentId) : null,
    name: f.name,
    createdAt: f.createdAt.toISOString(),
    updatedAt: f.updatedAt.toISOString(),
    deletedAt: isoOrNull(f.deletedAt),
  };
}

export function publicDocument(d: Document): PublicDocument {
  return {
    id: toPublic("doc", d.id),
    orgId: toPublic("org", d.orgId),
    folderId: d.folderId ? toPublic("fld", d.folderId) : null,
    name: d.name,
    currentVersion: d.currentVersion,
    pageCount: d.pageCount,
    size: d.size,
    ownerUserId: d.ownerUserId,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
    deletedAt: isoOrNull(d.deletedAt),
  };
}

export function publicVersion(v: Version): PublicVersion {
  return {
    docId: toPublic("doc", v.docId),
    version: v.version,
    sha256: v.sha256,
    size: v.size,
    pageCount: v.pageCount,
    createdBy: v.createdBy,
    actorKind: v.actorKind,
    restoredFrom: v.restoredFrom,
    createdAt: v.createdAt.toISOString(),
  };
}

export function publicTrashEntry(e: TrashEntry): PublicTrashEntry {
  return {
    kind: e.kind,
    id: toPublic(e.kind === "folder" ? "fld" : "doc", e.id),
    name: e.name,
    deletedAt: e.deletedAt.toISOString(),
    purgeAt: new Date(e.deletedAt.getTime() + TRASH_RETENTION_DAYS * 86_400_000).toISOString(),
  };
}
