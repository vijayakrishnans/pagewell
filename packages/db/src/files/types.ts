export type { SqlExecutor, SqlExecutorResult, SqlRow } from "../d1/executor.js";
import type { Uuid } from "../ids/index.js";

// The drive's persistence (PW2). Every method takes the org id first and every
// statement scopes by it: another org's row is `not_found`, never visible.

export type FilesRepositoryError =
  | { kind: "not_found" }
  | { kind: "conflict"; entity: "folder" | "document" | "version" | "upload" }
  /** A save named a baseVersion that is no longer current. */
  | { kind: "version_conflict"; currentVersion: number }
  /** A folder move would put a folder inside itself. */
  | { kind: "invalid_move" }
  | { kind: "internal"; message: string };

export type FilesResult<T> = { ok: true; value: T } | { ok: false; error: FilesRepositoryError };

export type ActorKind = "user" | "agent" | "mcp" | "api" | "sign";

export interface Folder {
  id: string;
  orgId: string;
  parentId: string | null;
  name: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface Document {
  id: string;
  orgId: string;
  folderId: string | null;
  name: string;
  currentVersion: number;
  pageCount: number | null;
  size: number;
  ownerUserId: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface Version {
  orgId: string;
  docId: string;
  version: number;
  r2Key: string;
  sha256: string;
  size: number;
  pageCount: number | null;
  createdBy: string;
  actorKind: ActorKind;
  provenance: Record<string, unknown> | null;
  restoredFrom: number | null;
  createdAt: Date;
}

export interface Upload {
  id: string;
  orgId: string;
  docId: string | null;
  folderId: string | null;
  name: string;
  r2Key: string;
  r2UploadId: string;
  parts: Array<{ partNumber: number; etag: string }>;
  baseVersion: number | null;
  createdBy: string;
  createdAt: Date;
  expiresAt: Date;
  completedAt: Date | null;
}

/** The object a version points at, as written to R2 before the row exists. */
export interface StoredObject {
  r2Key: string;
  sha256: string;
  size: number;
  pageCount: number | null;
}

export interface CreateFolderInput {
  id: Uuid;
  orgId: Uuid;
  parentId: Uuid | null;
  name: string;
  createdBy: string;
  now: Date;
}

export interface CreateDocumentInput {
  id: Uuid;
  orgId: Uuid;
  folderId: Uuid | null;
  name: string;
  ownerUserId: string;
  actorKind: ActorKind;
  provenance?: Record<string, unknown> | null;
  /** Version 1's object. */
  object: StoredObject;
  now: Date;
}

export interface AddVersionInput {
  orgId: Uuid;
  docId: Uuid;
  /** The version the writer started from; anything else is a version_conflict. */
  baseVersion: number;
  createdBy: string;
  actorKind: ActorKind;
  provenance?: Record<string, unknown> | null;
  object: StoredObject;
  restoredFrom?: number | null;
  now: Date;
}

export interface CreateUploadInput {
  id: Uuid;
  orgId: Uuid;
  docId: Uuid | null;
  folderId: Uuid | null;
  name: string;
  r2Key: string;
  r2UploadId: string;
  baseVersion: number | null;
  createdBy: string;
  now: Date;
  expiresAt: Date;
}

export interface Page<T> {
  items: T[];
  /** Opaque cursor for the next page, or null at the end. */
  nextCursor: string | null;
}

export interface ListQuery {
  limit: number;
  cursor?: string | null;
}

/** What a folder contains, live items only. `folderId` null = the org root. */
export interface FolderListing {
  folders: Folder[];
  documents: Document[];
}

export interface TrashEntry {
  kind: "folder" | "document";
  id: string;
  name: string;
  deletedAt: Date;
}

export interface UsageTotals {
  /** Bytes held by every version of every document, trashed ones included, counted once per object. */
  storageBytes: number;
  documents: number;
  versions: number;
}

export interface FilesRepository {
  createFolder(input: CreateFolderInput): Promise<FilesResult<Folder>>;
  getFolder(orgId: Uuid, folderId: Uuid): Promise<FilesResult<Folder>>;
  renameFolder(orgId: Uuid, folderId: Uuid, name: string, now: Date): Promise<FilesResult<Folder>>;
  moveFolder(orgId: Uuid, folderId: Uuid, parentId: Uuid | null, now: Date): Promise<FilesResult<Folder>>;
  /** Trash the folder and everything live under it, with one deleted_at. */
  trashFolder(orgId: Uuid, folderId: Uuid, now: Date): Promise<FilesResult<{ deletedAt: Date }>>;
  /** Bring back exactly the subtree that was trashed with this folder. */
  restoreFolder(orgId: Uuid, folderId: Uuid, now: Date): Promise<FilesResult<Folder>>;
  listFolder(orgId: Uuid, folderId: Uuid | null): Promise<FilesResult<FolderListing>>;

  createDocument(input: CreateDocumentInput): Promise<FilesResult<{ document: Document; version: Version }>>;
  getDocument(orgId: Uuid, docId: Uuid): Promise<FilesResult<Document>>;
  renameDocument(orgId: Uuid, docId: Uuid, name: string, now: Date): Promise<FilesResult<Document>>;
  moveDocument(orgId: Uuid, docId: Uuid, folderId: Uuid | null, now: Date): Promise<FilesResult<Document>>;
  trashDocument(orgId: Uuid, docId: Uuid, now: Date): Promise<FilesResult<{ deletedAt: Date }>>;
  restoreDocument(orgId: Uuid, docId: Uuid, now: Date): Promise<FilesResult<Document>>;
  listRecent(orgId: Uuid, query: ListQuery): Promise<FilesResult<Page<Document>>>;
  listTrash(orgId: Uuid): Promise<FilesResult<TrashEntry[]>>;

  addVersion(input: AddVersionInput): Promise<FilesResult<{ document: Document; version: Version }>>;
  getVersion(orgId: Uuid, docId: Uuid, version: number): Promise<FilesResult<Version>>;
  listVersions(orgId: Uuid, docId: Uuid): Promise<FilesResult<Version[]>>;

  createUpload(input: CreateUploadInput): Promise<FilesResult<Upload>>;
  getUpload(orgId: Uuid, uploadId: Uuid): Promise<FilesResult<Upload>>;
  recordUploadPart(orgId: Uuid, uploadId: Uuid, part: { partNumber: number; etag: string }): Promise<FilesResult<Upload>>;
  completeUpload(orgId: Uuid, uploadId: Uuid, now: Date): Promise<FilesResult<Upload>>;

  usage(orgId: Uuid): Promise<FilesResult<UsageTotals>>;

  /**
   * Housekeeping across orgs (the cron): trashed items older than `before` are
   * removed for good. Returns the R2 keys no remaining version points at, for
   * the caller to delete. Version 1 of a live document is never touched.
   */
  purgeTrash(before: Date, limit: number): Promise<FilesResult<{ documents: number; folders: number; r2Keys: string[] }>>;
  /** Unfinished uploads past their expiry, for the cron to abort in R2 and forget. */
  expiredUploads(now: Date, limit: number): Promise<FilesResult<Upload[]>>;
  forgetUpload(orgId: Uuid, uploadId: Uuid): Promise<FilesResult<void>>;
}
