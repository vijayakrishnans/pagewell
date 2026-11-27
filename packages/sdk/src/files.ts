import {
  BASE_VERSION_HEADER,
  PAGE_COUNT_HEADER,
  UPLOAD_PART_BYTES,
  type CompleteUploadRequest,
  type CreateDocumentResponse,
  type CreateFolderRequest,
  type CreateUploadRequest,
  type CreateVersionResponse,
  type DocumentResponse,
  type FilesQuotaResponse,
  type FolderListingResponse,
  type FolderResponse,
  type ListDocumentsResponse,
  type ListTrashResponse,
  type ListVersionsResponse,
  type UpdateDocumentRequest,
  type UpdateFolderRequest,
  type UploadPartResponse,
  type UploadResponse,
} from "@saas/contracts/files";

import type { RequestOptions, Transport } from "./transport.js";

/**
 * Pagewell's drive (PW2): folders, documents, versions, uploads, trash, quota.
 *
 * Org-scoped: every method takes `orgId` (an `org_…` id) first. Maps to
 * `apps/files-worker` through api-edge's files facade. PDF bodies go up as
 * bytes, not JSON; content comes back as a Response to stream or read.
 *
 * A save names the version it started from. When someone saved since, it
 * throws a ConflictError whose `code` is `version_conflict` and whose
 * `details.currentVersion` is the version now current.
 */
export class FilesClient {
  constructor(private readonly transport: Transport) {}

  private base(orgId: string): string {
    return `/v1/organizations/${encodeURIComponent(orgId)}`;
  }

  private async json<T>(response: Response): Promise<T> {
    const parsed = (await response.json()) as { data: T };
    return parsed.data;
  }

  // ---- Folders ----

  /** GET /folders (root) or /folders/:folderId — the listing with its breadcrumb. */
  listFolder(orgId: string, folderId: string | null = null, opts: RequestOptions = {}): Promise<FolderListingResponse> {
    const path = folderId ? `${this.base(orgId)}/folders/${encodeURIComponent(folderId)}` : `${this.base(orgId)}/folders`;
    return this.transport.request<FolderListingResponse>({ method: "GET", path }, opts);
  }

  createFolder(orgId: string, body: CreateFolderRequest, opts: RequestOptions = {}): Promise<FolderResponse> {
    return this.transport.request<FolderResponse>({ method: "POST", path: `${this.base(orgId)}/folders`, body }, opts);
  }

  updateFolder(orgId: string, folderId: string, body: UpdateFolderRequest, opts: RequestOptions = {}): Promise<FolderResponse> {
    return this.transport.request<FolderResponse>({ method: "PATCH", path: `${this.base(orgId)}/folders/${encodeURIComponent(folderId)}`, body }, opts);
  }

  /** Move a folder and everything in it to the trash. */
  trashFolder(orgId: string, folderId: string, opts: RequestOptions = {}): Promise<{ deletedAt: string }> {
    return this.transport.request({ method: "DELETE", path: `${this.base(orgId)}/folders/${encodeURIComponent(folderId)}` }, opts);
  }

  restoreFolder(orgId: string, folderId: string, opts: RequestOptions = {}): Promise<FolderResponse> {
    return this.transport.request<FolderResponse>({ method: "POST", path: `${this.base(orgId)}/folders/${encodeURIComponent(folderId)}/restore` }, opts);
  }

  // ---- Documents ----

  /** Recently changed documents, newest first. */
  listDocuments(orgId: string, query: { cursor?: string; limit?: number } = {}, opts: RequestOptions = {}): Promise<ListDocumentsResponse> {
    return this.transport.request<ListDocumentsResponse>(
      { method: "GET", path: `${this.base(orgId)}/documents`, query: { cursor: query.cursor, limit: query.limit } },
      opts,
    );
  }

  /** Upload a PDF (up to 95 MiB in one request) as a new document at version 1. */
  async upload(
    orgId: string,
    input: { name: string; pdf: BodyInit; folderId?: string | null; pageCount?: number | null },
    opts: RequestOptions = {},
  ): Promise<CreateDocumentResponse> {
    const res = await this.transport.send(
      {
        method: "POST",
        path: `${this.base(orgId)}/documents`,
        query: { name: input.name, folderId: input.folderId ?? undefined },
        body: input.pdf,
        contentType: "application/pdf",
      },
      withHeaders(opts, input.pageCount ? { [PAGE_COUNT_HEADER]: String(input.pageCount) } : {}),
    );
    return this.json<CreateDocumentResponse>(res);
  }

  getDocument(orgId: string, docId: string, opts: RequestOptions = {}): Promise<DocumentResponse> {
    return this.transport.request<DocumentResponse>({ method: "GET", path: `${this.base(orgId)}/documents/${encodeURIComponent(docId)}` }, opts);
  }

  updateDocument(orgId: string, docId: string, body: UpdateDocumentRequest, opts: RequestOptions = {}): Promise<DocumentResponse> {
    return this.transport.request<DocumentResponse>({ method: "PATCH", path: `${this.base(orgId)}/documents/${encodeURIComponent(docId)}`, body }, opts);
  }

  trashDocument(orgId: string, docId: string, opts: RequestOptions = {}): Promise<{ deletedAt: string }> {
    return this.transport.request({ method: "DELETE", path: `${this.base(orgId)}/documents/${encodeURIComponent(docId)}` }, opts);
  }

  restoreDocument(orgId: string, docId: string, opts: RequestOptions = {}): Promise<DocumentResponse> {
    return this.transport.request<DocumentResponse>({ method: "POST", path: `${this.base(orgId)}/documents/${encodeURIComponent(docId)}/restore` }, opts);
  }

  /** The PDF of `version` (default: the current one), as a Response to stream or read. */
  content(orgId: string, docId: string, version?: number, opts: RequestOptions = {}): Promise<Response> {
    return this.transport.send(
      { method: "GET", path: `${this.base(orgId)}/documents/${encodeURIComponent(docId)}/content`, query: { version } },
      opts,
    );
  }

  // ---- Versions ----

  listVersions(orgId: string, docId: string, opts: RequestOptions = {}): Promise<ListVersionsResponse> {
    return this.transport.request<ListVersionsResponse>({ method: "GET", path: `${this.base(orgId)}/documents/${encodeURIComponent(docId)}/versions` }, opts);
  }

  /** Save the whole PDF as the next version after `baseVersion`. */
  async save(
    orgId: string,
    docId: string,
    input: { baseVersion: number; pdf: BodyInit; pageCount?: number | null },
    opts: RequestOptions = {},
  ): Promise<CreateVersionResponse> {
    const res = await this.transport.send(
      { method: "POST", path: `${this.base(orgId)}/documents/${encodeURIComponent(docId)}/versions`, body: input.pdf, contentType: "application/pdf" },
      withHeaders(opts, {
        [BASE_VERSION_HEADER]: String(input.baseVersion),
        ...(input.pageCount ? { [PAGE_COUNT_HEADER]: String(input.pageCount) } : {}),
      }),
    );
    return this.json<CreateVersionResponse>(res);
  }

  /** Make version `n`'s content the next version. */
  restoreVersion(orgId: string, docId: string, n: number, baseVersion?: number, opts: RequestOptions = {}): Promise<CreateVersionResponse> {
    return this.transport.request<CreateVersionResponse>(
      { method: "POST", path: `${this.base(orgId)}/documents/${encodeURIComponent(docId)}/versions/${n}/restore` },
      baseVersion ? withHeaders(opts, { [BASE_VERSION_HEADER]: String(baseVersion) }) : opts,
    );
  }

  /** The browser's render of page 1 for this version (WebP or PNG, ≤ 512 KiB). */
  async putThumbnail(orgId: string, docId: string, version: number, image: Blob, opts: RequestOptions = {}): Promise<void> {
    await this.transport.send(
      { method: "PUT", path: `${this.base(orgId)}/documents/${encodeURIComponent(docId)}/versions/${version}/thumbnail`, body: image, contentType: image.type || "image/webp" },
      opts,
    );
  }

  thumbnail(orgId: string, docId: string, version: number, opts: RequestOptions = {}): Promise<Response> {
    return this.transport.send({ method: "GET", path: `${this.base(orgId)}/documents/${encodeURIComponent(docId)}/versions/${version}/thumbnail` }, opts);
  }

  /** The text the browser extracted from this version, for search and chat. */
  async putText(orgId: string, docId: string, version: number, text: { pages: Array<{ page: number; text: string }> }, opts: RequestOptions = {}): Promise<void> {
    await this.transport.send(
      { method: "PUT", path: `${this.base(orgId)}/documents/${encodeURIComponent(docId)}/versions/${version}/text`, body: JSON.stringify(text), contentType: "application/json" },
      opts,
    );
  }

  // ---- Multipart uploads (files over 95 MiB) ----

  createUpload(orgId: string, body: CreateUploadRequest, opts: RequestOptions = {}): Promise<UploadResponse> {
    return this.transport.request<UploadResponse>({ method: "POST", path: `${this.base(orgId)}/uploads`, body }, opts);
  }

  async uploadPart(orgId: string, uploadId: string, partNumber: number, bytes: BodyInit, opts: RequestOptions = {}): Promise<UploadPartResponse> {
    const res = await this.transport.send(
      { method: "PUT", path: `${this.base(orgId)}/uploads/${encodeURIComponent(uploadId)}/parts/${partNumber}`, body: bytes, contentType: "application/octet-stream" },
      opts,
    );
    return this.json<UploadPartResponse>(res);
  }

  completeUpload(orgId: string, uploadId: string, body: CompleteUploadRequest, opts: RequestOptions = {}): Promise<CreateDocumentResponse | CreateVersionResponse> {
    return this.transport.request({ method: "POST", path: `${this.base(orgId)}/uploads/${encodeURIComponent(uploadId)}/complete`, body }, opts);
  }

  async abortUpload(orgId: string, uploadId: string, opts: RequestOptions = {}): Promise<void> {
    await this.transport.send({ method: "DELETE", path: `${this.base(orgId)}/uploads/${encodeURIComponent(uploadId)}` }, opts);
  }

  /**
   * Upload a large file in parts: start, send each part, complete with the
   * file's sha256. A new document, or with `docId` + `baseVersion` the next
   * version of one. Aborts the upload if a step fails.
   */
  async uploadLarge(
    orgId: string,
    input: { file: Blob; name: string; sha256: string; folderId?: string | null; docId?: string | null; baseVersion?: number | null; pageCount?: number | null },
    opts: RequestOptions & { onProgress?: (sent: number, total: number) => void } = {},
  ): Promise<CreateDocumentResponse | CreateVersionResponse> {
    const { onProgress, ...rest } = opts;
    const started = await this.createUpload(
      orgId,
      { name: input.name, folderId: input.folderId ?? null, docId: input.docId ?? null, baseVersion: input.baseVersion ?? null, size: input.file.size },
      rest,
    );
    const { id, partSize } = started.upload;
    const step = partSize || UPLOAD_PART_BYTES;
    try {
      for (let at = 0, n = 1; at < input.file.size; at += step, n++) {
        await this.uploadPart(orgId, id, n, input.file.slice(at, at + step), rest);
        onProgress?.(Math.min(at + step, input.file.size), input.file.size);
      }
      return await this.completeUpload(orgId, id, { sha256: input.sha256, pageCount: input.pageCount ?? null }, rest);
    } catch (err) {
      await this.abortUpload(orgId, id).catch(() => undefined);
      throw err;
    }
  }

  // ---- Trash and quota ----

  listTrash(orgId: string, opts: RequestOptions = {}): Promise<ListTrashResponse> {
    return this.transport.request<ListTrashResponse>({ method: "GET", path: `${this.base(orgId)}/trash` }, opts);
  }

  quota(orgId: string, opts: RequestOptions = {}): Promise<FilesQuotaResponse> {
    return this.transport.request<FilesQuotaResponse>({ method: "GET", path: `${this.base(orgId)}/quota` }, opts);
  }
}

function withHeaders(opts: RequestOptions, headers: Record<string, string>): RequestOptions {
  return { ...opts, headers: { ...(opts.headers ?? {}), ...headers } };
}
