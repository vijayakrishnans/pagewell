import type { SqlExecutor, SqlRow, SqlStatement } from "../d1/executor.js";
import { executeBatch } from "../d1/executor.js";
import { isUniqueViolation } from "../d1/errors.js";
import type { Uuid } from "../ids/index.js";
import type {
  ActorKind,
  AddVersionInput,
  CreateDocumentInput,
  CreateFolderInput,
  CreateUploadInput,
  Document,
  FilesRepository,
  FilesResult,
  Folder,
  FolderListing,
  ListQuery,
  Page,
  TrashEntry,
  Upload,
  UsageTotals,
  Version,
} from "./types.js";

// Every statement below names org_id. The only exceptions are the two cron
// sweeps (purgeTrash, expiredUploads), which work across orgs by design and
// hand back rows that carry their org.

const LISTING_CAP = 1000;
// A folder subtree: the seed folder (live, in the org) and every live folder
// under it. $1 = org id, $2 = folder id.
const LIVE_SUBTREE = `WITH RECURSIVE sub(id) AS (
    SELECT id FROM files_folders WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL
    UNION ALL
    SELECT f.id FROM files_folders f JOIN sub ON f.parent_id = sub.id
     WHERE f.org_id = $1 AND f.deleted_at IS NULL
  ) SELECT id FROM sub`;
// The subtree trashed together with folder $2: everything under it whose
// deleted_at is the seed's ($3).
const TRASHED_SUBTREE = `WITH RECURSIVE sub(id) AS (
    SELECT id FROM files_folders WHERE org_id = $1 AND id = $2 AND deleted_at = $3
    UNION ALL
    SELECT f.id FROM files_folders f JOIN sub ON f.parent_id = sub.id
     WHERE f.org_id = $1 AND f.deleted_at = $3
  ) SELECT id FROM sub`;

const date = (v: unknown): Date => new Date(v as string);
const dateOrNull = (v: unknown): Date | null => (v ? new Date(v as string) : null);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function mapFolder(r: SqlRow): Folder {
  return {
    id: r.id as string,
    orgId: r.org_id as string,
    parentId: (r.parent_id as string | null) ?? null,
    name: r.name as string,
    createdBy: r.created_by as string,
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
    deletedAt: dateOrNull(r.deleted_at),
  };
}

function mapDocument(r: SqlRow): Document {
  return {
    id: r.id as string,
    orgId: r.org_id as string,
    folderId: (r.folder_id as string | null) ?? null,
    name: r.name as string,
    currentVersion: Number(r.current_version),
    pageCount: numOrNull(r.page_count),
    size: Number(r.size),
    ownerUserId: r.owner_user_id as string,
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
    deletedAt: dateOrNull(r.deleted_at),
  };
}

function mapVersion(r: SqlRow): Version {
  let provenance: Record<string, unknown> | null = null;
  if (typeof r.provenance_json === "string") {
    try {
      provenance = JSON.parse(r.provenance_json) as Record<string, unknown>;
    } catch {
      provenance = null;
    }
  }
  return {
    orgId: r.org_id as string,
    docId: r.doc_id as string,
    version: Number(r.version),
    r2Key: r.r2_key as string,
    sha256: r.sha256 as string,
    size: Number(r.size),
    pageCount: numOrNull(r.page_count),
    createdBy: r.created_by as string,
    actorKind: r.actor_kind as ActorKind,
    provenance,
    restoredFrom: numOrNull(r.restored_from),
    createdAt: date(r.created_at),
  };
}

function mapUpload(r: SqlRow): Upload {
  let parts: Upload["parts"] = [];
  try {
    parts = (JSON.parse((r.parts_json as string) ?? "[]") as Upload["parts"])
      .map((p) => ({ partNumber: Number(p.partNumber), etag: String(p.etag) }))
      .sort((a, b) => a.partNumber - b.partNumber);
  } catch {
    parts = [];
  }
  return {
    id: r.id as string,
    orgId: r.org_id as string,
    docId: (r.doc_id as string | null) ?? null,
    folderId: (r.folder_id as string | null) ?? null,
    name: r.name as string,
    r2Key: r.r2_key as string,
    r2UploadId: r.r2_upload_id as string,
    parts,
    baseVersion: numOrNull(r.base_version),
    createdBy: r.created_by as string,
    createdAt: date(r.created_at),
    expiresAt: date(r.expires_at),
    completedAt: dateOrNull(r.completed_at),
  };
}

const iso = (d: Date) => d.toISOString();
const fail = (message: string): FilesResult<never> => ({ ok: false, error: { kind: "internal", message } });
const notFound: FilesResult<never> = { ok: false, error: { kind: "not_found" } };

export function encodeCursor(updatedAt: string, id: string): string {
  return btoa(`${updatedAt}|${id}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeCursor(cursor: string): { updatedAt: string; id: string } | null {
  try {
    const raw = atob(cursor.replace(/-/g, "+").replace(/_/g, "/"));
    const [updatedAt, id, extra] = raw.split("|");
    if (!updatedAt || !id || extra !== undefined || Number.isNaN(Date.parse(updatedAt))) return null;
    return { updatedAt, id };
  } catch {
    return null;
  }
}

export function createFilesRepository(executor: SqlExecutor): FilesRepository {
  const one = async (text: string, params: unknown[]) => (await executor.execute(text, params)).rows[0];

  async function liveDocument(orgId: Uuid, docId: Uuid): Promise<FilesResult<Document>> {
    const row = await one(`SELECT * FROM files_documents WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL`, [orgId, docId]);
    return row ? { ok: true, value: mapDocument(row) } : notFound;
  }

  return {
    async createFolder(input: CreateFolderInput) {
      try {
        const row = await one(
          `INSERT INTO files_folders (id, org_id, parent_id, name, name_lower, created_by, created_at, updated_at)
           SELECT $1, $2, $3, $4, $5, $6, $7, $7
            WHERE $3 IS NULL
               OR EXISTS (SELECT 1 FROM files_folders WHERE org_id = $2 AND id = $3 AND deleted_at IS NULL)
           RETURNING *`,
          [input.id, input.orgId, input.parentId, input.name, input.name.toLowerCase(), input.createdBy, iso(input.now)],
        );
        return row ? { ok: true, value: mapFolder(row) } : notFound;
      } catch (err) {
        if (isUniqueViolation(err)) return { ok: false, error: { kind: "conflict", entity: "folder" } };
        return fail("Failed to create folder");
      }
    },

    async getFolder(orgId, folderId) {
      try {
        const row = await one(`SELECT * FROM files_folders WHERE org_id = $1 AND id = $2`, [orgId, folderId]);
        return row ? { ok: true, value: mapFolder(row) } : notFound;
      } catch {
        return fail("Failed to get folder");
      }
    },

    async renameFolder(orgId, folderId, name, now) {
      try {
        const row = await one(
          `UPDATE files_folders SET name = $3, name_lower = $4, updated_at = $5
            WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL
           RETURNING *`,
          [orgId, folderId, name, name.toLowerCase(), iso(now)],
        );
        return row ? { ok: true, value: mapFolder(row) } : notFound;
      } catch (err) {
        if (isUniqueViolation(err)) return { ok: false, error: { kind: "conflict", entity: "folder" } };
        return fail("Failed to rename folder");
      }
    },

    async moveFolder(orgId, folderId, parentId, now) {
      try {
        if (parentId !== null) {
          // The new parent may not be the folder or anything under it.
          const cycle = await one(
            `WITH RECURSIVE anc(id) AS (
               SELECT $2
               UNION
               SELECT f.parent_id FROM files_folders f JOIN anc ON f.id = anc.id
                WHERE f.org_id = $1 AND f.parent_id IS NOT NULL
             ) SELECT 1 AS hit FROM anc WHERE id = $3`,
            [orgId, parentId, folderId],
          );
          if (cycle) return { ok: false, error: { kind: "invalid_move" } };
        }
        const row = await one(
          `UPDATE files_folders SET parent_id = $3, updated_at = $4
            WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL
              AND ($3 IS NULL OR EXISTS (SELECT 1 FROM files_folders p WHERE p.org_id = $1 AND p.id = $3 AND p.deleted_at IS NULL))
           RETURNING *`,
          [orgId, folderId, parentId, iso(now)],
        );
        return row ? { ok: true, value: mapFolder(row) } : notFound;
      } catch (err) {
        if (isUniqueViolation(err)) return { ok: false, error: { kind: "conflict", entity: "folder" } };
        return fail("Failed to move folder");
      }
    },

    async trashFolder(orgId, folderId, now) {
      try {
        const live = await one(`SELECT id FROM files_folders WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL`, [orgId, folderId]);
        if (!live) return notFound;
        const at = iso(now);
        // Documents first: the subtree is computed from folders that are still live.
        await executeBatch(executor, [
          {
            text: `UPDATE files_documents SET deleted_at = $3, updated_at = $3
                    WHERE org_id = $1 AND deleted_at IS NULL AND folder_id IN (${LIVE_SUBTREE})`,
            params: [orgId, folderId, at],
          },
          {
            text: `UPDATE files_folders SET deleted_at = $3, updated_at = $3
                    WHERE org_id = $1 AND id IN (${LIVE_SUBTREE})`,
            params: [orgId, folderId, at],
          },
        ]);
        return { ok: true, value: { deletedAt: now } };
      } catch {
        return fail("Failed to trash folder");
      }
    },

    async restoreFolder(orgId, folderId, now) {
      try {
        const row = await one(`SELECT deleted_at FROM files_folders WHERE org_id = $1 AND id = $2 AND deleted_at IS NOT NULL`, [orgId, folderId]);
        if (!row) return notFound;
        const at = row.deleted_at as string;
        const statements: SqlStatement[] = [
          // A folder whose parent is gone comes back at the root.
          {
            text: `UPDATE files_folders SET parent_id = NULL
                    WHERE org_id = $1 AND id = $2 AND parent_id IS NOT NULL
                      AND NOT EXISTS (SELECT 1 FROM files_folders p
                                       WHERE p.org_id = $1 AND p.id = files_folders.parent_id AND p.deleted_at IS NULL)`,
            params: [orgId, folderId],
          },
          // Documents before folders: the subtree is found by the shared deleted_at.
          {
            text: `UPDATE files_documents SET deleted_at = NULL, updated_at = $4
                    WHERE org_id = $1 AND deleted_at = $3 AND folder_id IN (${TRASHED_SUBTREE})`,
            params: [orgId, folderId, at, iso(now)],
          },
          {
            text: `UPDATE files_folders SET deleted_at = NULL, updated_at = $4
                    WHERE org_id = $1 AND id IN (${TRASHED_SUBTREE})`,
            params: [orgId, folderId, at, iso(now)],
          },
        ];
        await executeBatch(executor, statements);
        const back = await one(`SELECT * FROM files_folders WHERE org_id = $1 AND id = $2`, [orgId, folderId]);
        return back ? { ok: true, value: mapFolder(back) } : notFound;
      } catch (err) {
        if (isUniqueViolation(err)) return { ok: false, error: { kind: "conflict", entity: "folder" } };
        return fail("Failed to restore folder");
      }
    },

    async listFolder(orgId, folderId) {
      try {
        if (folderId !== null) {
          const live = await one(`SELECT id FROM files_folders WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL`, [orgId, folderId]);
          if (!live) return notFound;
        }
        const folders = await executor.execute(
          `SELECT * FROM files_folders WHERE org_id = $1 AND parent_id IS $2 AND deleted_at IS NULL
            ORDER BY name_lower, id LIMIT ${LISTING_CAP}`,
          [orgId, folderId],
        );
        const documents = await executor.execute(
          `SELECT * FROM files_documents WHERE org_id = $1 AND folder_id IS $2 AND deleted_at IS NULL
            ORDER BY name_lower, id LIMIT ${LISTING_CAP}`,
          [orgId, folderId],
        );
        const value: FolderListing = { folders: folders.rows.map(mapFolder), documents: documents.rows.map(mapDocument) };
        return { ok: true, value };
      } catch {
        return fail("Failed to list folder");
      }
    },

    async createDocument(input: CreateDocumentInput) {
      try {
        const at = iso(input.now);
        const [docs, versions] = await executeBatch(executor, [
          {
            text: `INSERT INTO files_documents
                     (id, org_id, folder_id, name, name_lower, current_version, page_count, size, owner_user_id, created_at, updated_at)
                   SELECT $1, $2, $3, $4, $5, 1, $6, $7, $8, $9, $9
                    WHERE $3 IS NULL
                       OR EXISTS (SELECT 1 FROM files_folders WHERE org_id = $2 AND id = $3 AND deleted_at IS NULL)
                   RETURNING *`,
            params: [input.id, input.orgId, input.folderId, input.name, input.name.toLowerCase(), input.object.pageCount, input.object.size, input.ownerUserId, at],
          },
          {
            text: `INSERT INTO files_versions
                     (org_id, doc_id, version, r2_key, sha256, size, page_count, created_by, actor_kind, provenance_json, created_at)
                   SELECT $1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10
                    WHERE EXISTS (SELECT 1 FROM files_documents WHERE org_id = $1 AND id = $2)
                   RETURNING *`,
            params: [input.orgId, input.id, input.object.r2Key, input.object.sha256, input.object.size, input.object.pageCount, input.ownerUserId, input.actorKind, input.provenance ? JSON.stringify(input.provenance) : null, at],
          },
        ]);
        const doc = docs?.rows[0];
        const version = versions?.rows[0];
        if (!doc || !version) return notFound; // the folder is not live in this org
        return { ok: true, value: { document: mapDocument(doc), version: mapVersion(version) } };
      } catch (err) {
        if (isUniqueViolation(err)) return { ok: false, error: { kind: "conflict", entity: "document" } };
        return fail("Failed to create document");
      }
    },

    async getDocument(orgId, docId) {
      try {
        const row = await one(`SELECT * FROM files_documents WHERE org_id = $1 AND id = $2`, [orgId, docId]);
        return row ? { ok: true, value: mapDocument(row) } : notFound;
      } catch {
        return fail("Failed to get document");
      }
    },

    async renameDocument(orgId, docId, name, now) {
      try {
        const row = await one(
          `UPDATE files_documents SET name = $3, name_lower = $4, updated_at = $5
            WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL RETURNING *`,
          [orgId, docId, name, name.toLowerCase(), iso(now)],
        );
        return row ? { ok: true, value: mapDocument(row) } : notFound;
      } catch {
        return fail("Failed to rename document");
      }
    },

    async moveDocument(orgId, docId, folderId, now) {
      try {
        const row = await one(
          `UPDATE files_documents SET folder_id = $3, updated_at = $4
            WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL
              AND ($3 IS NULL OR EXISTS (SELECT 1 FROM files_folders f WHERE f.org_id = $1 AND f.id = $3 AND f.deleted_at IS NULL))
           RETURNING *`,
          [orgId, docId, folderId, iso(now)],
        );
        return row ? { ok: true, value: mapDocument(row) } : notFound;
      } catch {
        return fail("Failed to move document");
      }
    },

    async trashDocument(orgId, docId, now) {
      try {
        const row = await one(
          `UPDATE files_documents SET deleted_at = $3, updated_at = $3
            WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL RETURNING deleted_at`,
          [orgId, docId, iso(now)],
        );
        return row ? { ok: true, value: { deletedAt: date(row.deleted_at) } } : notFound;
      } catch {
        return fail("Failed to trash document");
      }
    },

    async restoreDocument(orgId, docId, now) {
      try {
        // A document whose folder is gone comes back at the root.
        const row = await one(
          `UPDATE files_documents
              SET deleted_at = NULL, updated_at = $3,
                  folder_id = CASE WHEN EXISTS (SELECT 1 FROM files_folders f
                                                 WHERE f.org_id = $1 AND f.id = files_documents.folder_id AND f.deleted_at IS NULL)
                                   THEN folder_id ELSE NULL END
            WHERE org_id = $1 AND id = $2 AND deleted_at IS NOT NULL RETURNING *`,
          [orgId, docId, iso(now)],
        );
        return row ? { ok: true, value: mapDocument(row) } : notFound;
      } catch {
        return fail("Failed to restore document");
      }
    },

    async listRecent(orgId, query: ListQuery) {
      try {
        const limit = Math.max(1, Math.min(100, Math.floor(query.limit)));
        const cursor = query.cursor ? decodeCursor(query.cursor) : null;
        if (query.cursor && !cursor) return { ok: false, error: { kind: "internal", message: "invalid cursor" } };
        const { rows } = cursor
          ? await executor.execute(
              `SELECT * FROM files_documents WHERE org_id = $1 AND deleted_at IS NULL
                 AND (updated_at, id) < ($3, $4)
               ORDER BY updated_at DESC, id DESC LIMIT $2`,
              [orgId, limit + 1, cursor.updatedAt, cursor.id],
            )
          : await executor.execute(
              `SELECT * FROM files_documents WHERE org_id = $1 AND deleted_at IS NULL
               ORDER BY updated_at DESC, id DESC LIMIT $2`,
              [orgId, limit + 1],
            );
        const items = rows.slice(0, limit).map(mapDocument);
        const last = rows.length > limit ? rows[limit - 1] : undefined;
        const page: Page<Document> = { items, nextCursor: last ? encodeCursor(last.updated_at as string, last.id as string) : null };
        return { ok: true, value: page };
      } catch {
        return fail("Failed to list documents");
      }
    },

    async listTrash(orgId) {
      try {
        // What the Trash shows: the top of each trashed set, not everything under a trashed folder.
        const { rows } = await executor.execute(
          `SELECT 'folder' AS kind, f.id, f.name, f.deleted_at FROM files_folders f
            WHERE f.org_id = $1 AND f.deleted_at IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM files_folders p WHERE p.org_id = $1 AND p.id = f.parent_id AND p.deleted_at = f.deleted_at)
           UNION ALL
           SELECT 'document' AS kind, d.id, d.name, d.deleted_at FROM files_documents d
            WHERE d.org_id = $1 AND d.deleted_at IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM files_folders p WHERE p.org_id = $1 AND p.id = d.folder_id AND p.deleted_at = d.deleted_at)
           ORDER BY deleted_at DESC, id DESC LIMIT ${LISTING_CAP}`,
          [orgId],
        );
        const value: TrashEntry[] = rows.map((r) => ({
          kind: r.kind as TrashEntry["kind"],
          id: r.id as string,
          name: r.name as string,
          deletedAt: date(r.deleted_at),
        }));
        return { ok: true, value };
      } catch {
        return fail("Failed to list trash");
      }
    },

    async addVersion(input: AddVersionInput) {
      const next = input.baseVersion + 1;
      try {
        const at = iso(input.now);
        // Both statements are conditional on current_version = baseVersion, so a
        // stale writer changes nothing; the primary key (doc_id, version) is the
        // backstop if two writers ever got past that together.
        const [versions, docs] = await executeBatch(executor, [
          {
            text: `INSERT INTO files_versions
                     (org_id, doc_id, version, r2_key, sha256, size, page_count, created_by, actor_kind, provenance_json, restored_from, created_at)
                   SELECT $1, $2, $3, $5, $6, $7, $8, $9, $10, $11, $12, $13
                     FROM files_documents
                    WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL AND current_version = $4
                   RETURNING *`,
            params: [
              input.orgId, input.docId, next, input.baseVersion,
              input.object.r2Key, input.object.sha256, input.object.size, input.object.pageCount,
              input.createdBy, input.actorKind, input.provenance ? JSON.stringify(input.provenance) : null,
              input.restoredFrom ?? null, at,
            ],
          },
          {
            text: `UPDATE files_documents SET current_version = $3, size = $5, page_count = $6, updated_at = $7
                    WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL AND current_version = $4
                   RETURNING *`,
            params: [input.orgId, input.docId, next, input.baseVersion, input.object.size, input.object.pageCount, at],
          },
        ]);
        const version = versions?.rows[0];
        const doc = docs?.rows[0];
        if (version && doc) return { ok: true, value: { document: mapDocument(doc), version: mapVersion(version) } };
      } catch (err) {
        if (!isUniqueViolation(err)) return fail("Failed to add version");
      }
      const current = await liveDocument(input.orgId, input.docId);
      if (!current.ok) return current;
      return { ok: false, error: { kind: "version_conflict", currentVersion: current.value.currentVersion } };
    },

    async getVersion(orgId, docId, version) {
      try {
        const row = await one(`SELECT * FROM files_versions WHERE org_id = $1 AND doc_id = $2 AND version = $3`, [orgId, docId, version]);
        return row ? { ok: true, value: mapVersion(row) } : notFound;
      } catch {
        return fail("Failed to get version");
      }
    },

    async listVersions(orgId, docId) {
      try {
        const doc = await one(`SELECT id FROM files_documents WHERE org_id = $1 AND id = $2`, [orgId, docId]);
        if (!doc) return notFound;
        const { rows } = await executor.execute(
          `SELECT * FROM files_versions WHERE org_id = $1 AND doc_id = $2 ORDER BY version DESC LIMIT ${LISTING_CAP}`,
          [orgId, docId],
        );
        return { ok: true, value: rows.map(mapVersion) };
      } catch {
        return fail("Failed to list versions");
      }
    },

    async createUpload(input: CreateUploadInput) {
      try {
        const row = await one(
          `INSERT INTO files_uploads
             (id, org_id, doc_id, folder_id, name, r2_key, r2_upload_id, base_version, created_by, created_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
          [input.id, input.orgId, input.docId, input.folderId, input.name, input.r2Key, input.r2UploadId, input.baseVersion, input.createdBy, iso(input.now), iso(input.expiresAt)],
        );
        return row ? { ok: true, value: mapUpload(row) } : fail("Failed to create upload");
      } catch (err) {
        if (isUniqueViolation(err)) return { ok: false, error: { kind: "conflict", entity: "upload" } };
        return fail("Failed to create upload");
      }
    },

    async getUpload(orgId, uploadId) {
      try {
        const row = await one(`SELECT * FROM files_uploads WHERE org_id = $1 AND id = $2`, [orgId, uploadId]);
        return row ? { ok: true, value: mapUpload(row) } : notFound;
      } catch {
        return fail("Failed to get upload");
      }
    },

    async recordUploadPart(orgId, uploadId, part) {
      try {
        // One statement, so parts uploaded in parallel cannot lose each other.
        const row = await one(
          `UPDATE files_uploads
              SET parts_json = (
                SELECT json_group_array(json(value)) FROM (
                  SELECT value FROM json_each(files_uploads.parts_json)
                   WHERE json_extract(value, '$.partNumber') <> $3
                  UNION ALL
                  SELECT json_object('partNumber', $3, 'etag', $4)
                )
              )
            WHERE org_id = $1 AND id = $2 AND completed_at IS NULL RETURNING *`,
          [orgId, uploadId, part.partNumber, part.etag],
        );
        return row ? { ok: true, value: mapUpload(row) } : notFound;
      } catch {
        return fail("Failed to record upload part");
      }
    },

    async completeUpload(orgId, uploadId, now) {
      try {
        const row = await one(
          `UPDATE files_uploads SET completed_at = $3
            WHERE org_id = $1 AND id = $2 AND completed_at IS NULL RETURNING *`,
          [orgId, uploadId, iso(now)],
        );
        return row ? { ok: true, value: mapUpload(row) } : notFound;
      } catch {
        return fail("Failed to complete upload");
      }
    },

    async usage(orgId) {
      try {
        // A restore points a new version at an existing object, so bytes count once per R2 key.
        const row = await one(
          `SELECT
             (SELECT ifnull(sum(size), 0) FROM (SELECT max(size) AS size FROM files_versions WHERE org_id = $1 GROUP BY r2_key)) AS storage_bytes,
             (SELECT count(*) FROM files_documents WHERE org_id = $1) AS documents,
             (SELECT count(*) FROM files_versions WHERE org_id = $1) AS versions`,
          [orgId],
        );
        const value: UsageTotals = {
          storageBytes: Number(row?.storage_bytes ?? 0),
          documents: Number(row?.documents ?? 0),
          versions: Number(row?.versions ?? 0),
        };
        return { ok: true, value };
      } catch {
        return fail("Failed to read usage");
      }
    },

    async purgeTrash(before, limit) {
      try {
        const cutoff = iso(before);
        const docs = await executor.execute(
          `SELECT org_id, id FROM files_documents WHERE deleted_at IS NOT NULL AND deleted_at < $1
            ORDER BY deleted_at LIMIT $2`,
          [cutoff, Math.max(1, Math.min(500, limit))],
        );
        const r2Keys = new Set<string>();
        let documents = 0;
        for (const d of docs.rows) {
          const { rows } = await executor.execute(
            `SELECT DISTINCT r2_key FROM files_versions WHERE org_id = $1 AND doc_id = $2`,
            [d.org_id, d.id],
          );
          const results = await executeBatch(executor, [
            { text: `DELETE FROM files_versions WHERE org_id = $1 AND doc_id = $2`, params: [d.org_id, d.id] },
            {
              text: `DELETE FROM files_documents WHERE org_id = $1 AND id = $2 AND deleted_at IS NOT NULL AND deleted_at < $3 RETURNING id`,
              params: [d.org_id, d.id, cutoff],
            },
          ]);
          if (results[1]?.rows.length) {
            documents += 1;
            // Object keys carry the document id, so no other document shares them.
            for (const r of rows) r2Keys.add(r.r2_key as string);
          }
        }
        // Folders go leaves first; anything still holding a child waits for a later sweep.
        let folders = 0;
        for (let depth = 0; depth < 64; depth += 1) {
          const { rows } = await executor.execute(
            `DELETE FROM files_folders
              WHERE deleted_at IS NOT NULL AND deleted_at < $1
                AND NOT EXISTS (SELECT 1 FROM files_folders c WHERE c.org_id = files_folders.org_id AND c.parent_id = files_folders.id)
                AND NOT EXISTS (SELECT 1 FROM files_documents d WHERE d.org_id = files_folders.org_id AND d.folder_id = files_folders.id)
              RETURNING id`,
            [cutoff],
          );
          if (rows.length === 0) break;
          folders += rows.length;
        }
        return { ok: true, value: { documents, folders, r2Keys: [...r2Keys] } };
      } catch {
        return fail("Failed to purge trash");
      }
    },

    async expiredUploads(now, limit) {
      try {
        const { rows } = await executor.execute(
          `SELECT * FROM files_uploads WHERE completed_at IS NULL AND expires_at < $1 ORDER BY expires_at LIMIT $2`,
          [iso(now), Math.max(1, Math.min(500, limit))],
        );
        return { ok: true, value: rows.map(mapUpload) };
      } catch {
        return fail("Failed to list expired uploads");
      }
    },

    async forgetUpload(orgId, uploadId) {
      try {
        await executor.execute(`DELETE FROM files_uploads WHERE org_id = $1 AND id = $2`, [orgId, uploadId]);
        return { ok: true, value: undefined };
      } catch {
        return fail("Failed to forget upload");
      }
    },
  };
}
