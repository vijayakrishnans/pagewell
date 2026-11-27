-- 200_files_core
-- Pagewell drive foundation — folders, documents, versions and multipart uploads
-- Bounded context: files
-- schema files: Pagewell's drive — owns folders, documents, their versions and in-flight uploads.
--
-- Every table carries org_id and every query scopes by it: a row in another
-- organization is never found (the API answers 404, never 403). Ids are bare
-- UUIDs; the API speaks fld_/doc_/upl_ + 32 hex. Deletes are soft (deleted_at)
-- with a 30-day trash; a folder and everything under it is trashed with ONE
-- deleted_at, which is how a restore brings back exactly that subtree.

CREATE TABLE IF NOT EXISTS files_folders (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  parent_id   TEXT,
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  name_lower  TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at  TEXT,
  FOREIGN KEY (org_id, parent_id) REFERENCES files_folders (org_id, id)
);

-- table files_folders: Folders in an organization's drive. parent_id NULL = the org root.
-- column files_folders.org_id: Owning organization — opaque reference, no cross-context FK.
-- column files_folders.name_lower: Lowercased name; live siblings may not share it.
-- column files_folders.deleted_at: Set when trashed; the whole trashed subtree shares one value.

CREATE UNIQUE INDEX IF NOT EXISTS files_folders_org_id_idx
  ON files_folders (org_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS files_folders_live_name_idx
  ON files_folders (org_id, ifnull(parent_id, ''), name_lower)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS files_folders_org_parent_idx
  ON files_folders (org_id, parent_id, name_lower);

CREATE TABLE IF NOT EXISTS files_documents (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  folder_id       TEXT,
  name            TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  name_lower      TEXT NOT NULL,
  current_version INTEGER NOT NULL CHECK (current_version >= 1),
  page_count      INTEGER,
  size            INTEGER NOT NULL CHECK (size >= 0),
  owner_user_id   TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at      TEXT,
  FOREIGN KEY (org_id, folder_id) REFERENCES files_folders (org_id, id)
);

-- table files_documents: PDFs in an organization's drive. Every query must scope by org_id.
-- column files_documents.current_version: The version the drive opens; a save must name it as baseVersion.
-- column files_documents.size: Bytes of the current version.
-- column files_documents.deleted_at: Set when trashed (alone, or with its folder's subtree).

CREATE UNIQUE INDEX IF NOT EXISTS files_documents_org_id_idx
  ON files_documents (org_id, id);

CREATE INDEX IF NOT EXISTS files_documents_org_folder_idx
  ON files_documents (org_id, folder_id, name_lower);

CREATE INDEX IF NOT EXISTS files_documents_org_updated_idx
  ON files_documents (org_id, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS files_documents_deleted_idx
  ON files_documents (deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS files_versions (
  org_id          TEXT NOT NULL,
  doc_id          TEXT NOT NULL,
  version         INTEGER NOT NULL CHECK (version >= 1),
  r2_key          TEXT NOT NULL,
  sha256          TEXT NOT NULL CHECK (length(sha256) = 64),
  size            INTEGER NOT NULL CHECK (size >= 0),
  page_count      INTEGER,
  created_by      TEXT NOT NULL,
  actor_kind      TEXT NOT NULL CHECK (actor_kind IN ('user', 'agent', 'mcp', 'api', 'sign')),
  provenance_json TEXT,
  restored_from   INTEGER,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (doc_id, version),
  FOREIGN KEY (org_id, doc_id) REFERENCES files_documents (org_id, id)
);

-- table files_versions: Every saved state of a document. Version numbers come from the primary key, never a counter read.
-- column files_versions.r2_key: org/<orgId>/doc/<docId>/v/<n>.pdf — a restore points at the restored version's object.
-- column files_versions.actor_kind: Who made it: a person, the in-editor agent, MCP, the API, or signing.
-- column files_versions.restored_from: The version this one restores, when it is a restore.

CREATE INDEX IF NOT EXISTS files_versions_org_doc_idx
  ON files_versions (org_id, doc_id, version DESC);

CREATE TABLE IF NOT EXISTS files_uploads (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  doc_id        TEXT,
  folder_id     TEXT,
  name          TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  r2_key        TEXT NOT NULL,
  r2_upload_id  TEXT NOT NULL,
  parts_json    TEXT NOT NULL DEFAULT '[]',
  base_version  INTEGER,
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at    TEXT NOT NULL,
  completed_at  TEXT
);

-- table files_uploads: In-flight R2 multipart uploads (org/<orgId>/tmp/<uploadId>). A new document when doc_id is NULL, else a new version on base_version.
-- column files_uploads.parts_json: The parts R2 acknowledged, [{partNumber, etag}].
-- column files_uploads.expires_at: After this an unfinished upload is aborted and its row removed.

CREATE INDEX IF NOT EXISTS files_uploads_org_idx
  ON files_uploads (org_id, id);

CREATE INDEX IF NOT EXISTS files_uploads_expires_idx
  ON files_uploads (expires_at) WHERE completed_at IS NULL;
