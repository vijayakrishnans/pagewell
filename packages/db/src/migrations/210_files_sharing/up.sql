-- 210_files_sharing
-- Pagewell drive sharing (PW3) — grants, share links and their opens, guests
-- Bounded context: files
--
-- Every table carries org_id and every query scopes by it, except the one lookup
-- a share link needs before its org is known (by token hash) and "Shared with
-- me", which reads one person's grants across orgs. Grants on a folder reach
-- everything under it; that is computed at read time from the folder tree, so a
-- move changes inherited access with no rewrite. Link tokens are never stored,
-- only their SHA-256; link passwords only as PBKDF2 hashes.

CREATE TABLE IF NOT EXISTS files_guests (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  email        TEXT NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
  name         TEXT,
  invited_by   TEXT NOT NULL,
  invited_at   TEXT NOT NULL,
  user_id      TEXT,
  verified_at  TEXT,
  removed_at   TEXT
);

-- table files_guests: People outside an organization that something in its drive was shared with, by email.
-- column files_guests.email: Lower-cased; a guest is matched by the verified email they sign in with.
-- column files_guests.user_id: The account that first signed in with this email and opened the share.
-- column files_guests.verified_at: When that sign-in (a magic link to this email) proved the address.
-- column files_guests.removed_at: Set when an admin removes the guest; their grants are deleted with it.

CREATE UNIQUE INDEX IF NOT EXISTS files_guests_live_email_idx
  ON files_guests (org_id, email) WHERE removed_at IS NULL;

CREATE INDEX IF NOT EXISTS files_guests_email_idx
  ON files_guests (email) WHERE removed_at IS NULL;

CREATE TABLE IF NOT EXISTS files_grants (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  resource_kind   TEXT NOT NULL CHECK (resource_kind IN ('folder', 'document')),
  resource_id     TEXT NOT NULL,
  principal_kind  TEXT NOT NULL CHECK (principal_kind IN ('member', 'guest')),
  principal_id    TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('editor', 'commenter', 'viewer')),
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- table files_grants: A role on one folder or document for one member or guest. Folder grants reach everything under the folder.
-- column files_grants.principal_id: A member's public user id (usr_…), or a files_guests id.
-- column files_grants.role: editor, commenter or viewer; the most permissive grant that reaches a resource wins.

CREATE UNIQUE INDEX IF NOT EXISTS files_grants_one_per_principal_idx
  ON files_grants (org_id, resource_kind, resource_id, principal_kind, principal_id);

CREATE INDEX IF NOT EXISTS files_grants_principal_idx
  ON files_grants (principal_kind, principal_id);

CREATE TABLE IF NOT EXISTS files_links (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  resource_kind   TEXT NOT NULL CHECK (resource_kind IN ('folder', 'document')),
  resource_id     TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('viewer', 'commenter')),
  token_hash      TEXT NOT NULL CHECK (length(token_hash) = 64),
  password_hash   TEXT,
  expires_at      TEXT,
  allow_download  INTEGER NOT NULL DEFAULT 1 CHECK (allow_download IN (0, 1)),
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  revoked_at      TEXT
);

-- table files_links: Share links to a folder or document. Viewer or commenter only, never editor.
-- column files_links.token_hash: SHA-256 (hex) of the link's secret token; the token itself is shown once and never stored.
-- column files_links.password_hash: pbkdf2-sha256$<iterations>$<salt b64url>$<hash b64url>, or NULL for no password.
-- column files_links.allow_download: Whether the viewer offers a download. The bytes still reach the browser to render.
-- column files_links.revoked_at: Set on revoke; a revoked link answers 404 from the next request on.

CREATE UNIQUE INDEX IF NOT EXISTS files_links_token_idx
  ON files_links (token_hash);

CREATE INDEX IF NOT EXISTS files_links_resource_idx
  ON files_links (org_id, resource_kind, resource_id);

CREATE TABLE IF NOT EXISTS files_link_opens (
  org_id     TEXT NOT NULL,
  link_id    TEXT NOT NULL,
  opened_at  TEXT NOT NULL,
  ip_hash    TEXT,
  ua_hash    TEXT
);

-- table files_link_opens: Each time a share link was opened. Hashes only, never the address or user agent.
-- column files_link_opens.ip_hash: SHA-256 of the day and the client address, so opens can be told apart within a day only.

CREATE INDEX IF NOT EXISTS files_link_opens_link_idx
  ON files_link_opens (org_id, link_id, opened_at DESC);
