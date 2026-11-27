// Wire types for Pagewell's drive (PW2): files-worker, behind api-edge's
// /v1/orgs/{org}/folders|documents facades, in the { data, meta } envelope.
// Ids on the wire are public: fld_/doc_/upl_ + 32 hex.

/** Error codes the drive adds to the shared set (errors.ts). */
export const FILES_ERROR_CODES = {
  /** A save named a baseVersion that is no longer current. 409; carries currentVersion. */
  VERSION_CONFLICT: "version_conflict",
  /** Storage, file size or version count over the org's plan. 402. */
  QUOTA_EXCEEDED: "quota_exceeded",
  /** The body is not a PDF (no %PDF- header). 415. */
  NOT_A_PDF: "not_a_pdf",
  /** A folder move would put the folder inside itself. 422. */
  INVALID_MOVE: "invalid_move",
} as const;

export type FilesErrorCode = (typeof FILES_ERROR_CODES)[keyof typeof FILES_ERROR_CODES];

export type ActorKind = "user" | "agent" | "mcp" | "api" | "sign";

export interface PublicFolder {
  id: string;
  orgId: string;
  parentId: string | null;
  name: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface PublicDocument {
  id: string;
  orgId: string;
  folderId: string | null;
  name: string;
  currentVersion: number;
  pageCount: number | null;
  size: number;
  ownerUserId: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface PublicVersion {
  docId: string;
  version: number;
  sha256: string;
  size: number;
  pageCount: number | null;
  createdBy: string;
  actorKind: ActorKind;
  restoredFrom: number | null;
  createdAt: string;
}

export interface PublicTrashEntry {
  kind: "folder" | "document";
  id: string;
  name: string;
  deletedAt: string;
  /** When the cron removes it for good (deletedAt + 30 days). */
  purgeAt: string;
}

export interface FilesQuota {
  storageBytes: { used: number; limit: number };
  maxFileBytes: number;
  maxVersionsPerDocument: number;
}

// Folders
export interface CreateFolderRequest {
  name: string;
  parentId?: string | null;
}
export interface UpdateFolderRequest {
  name?: string;
  parentId?: string | null;
}
export interface FolderResponse {
  folder: PublicFolder;
}
export interface FolderListingResponse {
  folder: PublicFolder | null;
  /** Root first, the folder itself last; empty at the org root. */
  breadcrumb: Array<{ id: string; name: string }>;
  folders: PublicFolder[];
  documents: PublicDocument[];
}

// Documents. A small upload is one request: POST /documents with the PDF as the
// body (Content-Type: application/pdf) and ?name=&folderId=. A large one uses
// the multipart flow under /uploads.
export interface DocumentResponse {
  document: PublicDocument;
}
export interface CreateDocumentResponse {
  document: PublicDocument;
  version: PublicVersion;
}
export interface UpdateDocumentRequest {
  name?: string;
  folderId?: string | null;
}
export interface ListDocumentsResponse {
  documents: PublicDocument[];
  nextCursor: string | null;
}

// Versions. A save is POST /documents/{doc}/versions with the whole PDF as the
// body and the base in the X-Pagewell-Base-Version header.
export const BASE_VERSION_HEADER = "x-pagewell-base-version";
export interface ListVersionsResponse {
  versions: PublicVersion[];
}
export interface CreateVersionResponse {
  document: PublicDocument;
  version: PublicVersion;
}
export interface VersionConflictBody {
  error: "version_conflict";
  message: string;
  currentVersion: number;
}

// Multipart uploads (files over one request's size).
export interface CreateUploadRequest {
  name: string;
  folderId?: string | null;
  /** Present when the upload becomes a new version of this document. */
  docId?: string | null;
  baseVersion?: number | null;
  size: number;
}
export interface UploadResponse {
  upload: { id: string; partSize: number; expiresAt: string };
}
export interface UploadPartResponse {
  partNumber: number;
}

// Trash and quota
export interface ListTrashResponse {
  entries: PublicTrashEntry[];
}
export interface FilesQuotaResponse {
  quota: FilesQuota;
}

/** How long the trash keeps an item. */
export const TRASH_RETENTION_DAYS = 30;
