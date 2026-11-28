import type { SqlExecutor, SqlRow } from "../d1/executor.js";
import { executeBatch } from "../d1/executor.js";
import { isUniqueViolation } from "../d1/errors.js";
import type { Uuid } from "../ids/index.js";
import type { FilesResult } from "./types.js";

// Sharing in the drive (PW3): grants, guests, share links. Every statement names
// org_id, except the two that cannot know it yet: a share link's lookup by token
// hash, and one person's "Shared with me" across orgs. Folder grants reach down
// the tree; that is resolved here at read time from the folders' parent chain.

export type ResourceKind = "folder" | "document";
export type GrantRole = "editor" | "commenter" | "viewer";
export type LinkRole = "viewer" | "commenter";
export type PrincipalKind = "member" | "guest";

export interface ResourceRef {
  kind: ResourceKind;
  id: Uuid;
}

export interface Grant {
  id: string;
  orgId: string;
  resourceKind: ResourceKind;
  resourceId: string;
  principalKind: PrincipalKind;
  /** A member's public user id (usr_…), or a guest id. */
  principalId: string;
  role: GrantRole;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Guest {
  id: string;
  orgId: string;
  email: string;
  name: string | null;
  invitedBy: string;
  invitedAt: Date;
  userId: string | null;
  verifiedAt: Date | null;
  removedAt: Date | null;
}

export interface ShareLink {
  id: string;
  orgId: string;
  resourceKind: ResourceKind;
  resourceId: string;
  role: LinkRole;
  tokenHash: string;
  passwordHash: string | null;
  expiresAt: Date | null;
  allowDownload: boolean;
  createdBy: string;
  createdAt: Date;
  revokedAt: Date | null;
}

/** Who is asking, for grant matching: their member id, and the verified email guest grants match. */
export interface Principals {
  memberId: string | null;
  email: string | null;
}

export interface SharedItem {
  grant: Grant;
  name: string;
  updatedAt: Date;
  /** For a document: its current version, size and page count. */
  document: { currentVersion: number; size: number; pageCount: number | null; folderId: string | null } | null;
}

export interface PutGrantInput {
  id: Uuid;
  orgId: Uuid;
  resource: ResourceRef;
  principalKind: PrincipalKind;
  principalId: string;
  role: GrantRole;
  createdBy: string;
  now: Date;
}

export interface CreateLinkInput {
  id: Uuid;
  orgId: Uuid;
  resource: ResourceRef;
  role: LinkRole;
  tokenHash: string;
  passwordHash: string | null;
  expiresAt: Date | null;
  allowDownload: boolean;
  createdBy: string;
  now: Date;
}

export interface SharingRepository {
  /**
   * The grants that reach a resource: its own, and (for anything in a folder) every folder
   * above it. With `who`, only that person's (their member grants and the guest grants for
   * their email). Each grant says which resource it sits on, so callers can show "from <folder>".
   */
  grantsReaching(orgId: Uuid, resource: ResourceRef, who?: Principals): Promise<FilesResult<Grant[]>>;
  /** Add a grant, or change the role of the one this principal already has on this resource. */
  putGrant(input: PutGrantInput): Promise<FilesResult<{ grant: Grant; created: boolean; previousRole: GrantRole | null }>>;
  getGrant(orgId: Uuid, grantId: Uuid): Promise<FilesResult<Grant>>;
  deleteGrant(orgId: Uuid, grantId: Uuid): Promise<FilesResult<Grant>>;

  /** The live guest record for this email in the org, created if there is none. */
  inviteGuest(input: { id: Uuid; orgId: Uuid; email: string; name: string | null; invitedBy: string; now: Date }): Promise<FilesResult<{ guest: Guest; created: boolean }>>;
  getGuest(orgId: Uuid, guestId: Uuid): Promise<FilesResult<Guest>>;
  listGuests(orgId: Uuid): Promise<FilesResult<Guest[]>>;
  /** Record the first verified sign-in of this guest's email (and which account it was). */
  verifyGuest(orgId: Uuid, guestId: Uuid, userId: string, now: Date): Promise<FilesResult<{ guest: Guest; firstTime: boolean }>>;
  /** The org's live guest records for this email (a guest opening something shared with them). */
  guestsForEmail(orgId: Uuid, email: string): Promise<FilesResult<Guest[]>>;
  /** Remove a guest and every grant they hold. */
  removeGuest(orgId: Uuid, guestId: Uuid, now: Date): Promise<FilesResult<{ guest: Guest; grants: number }>>;

  createLink(input: CreateLinkInput): Promise<FilesResult<ShareLink>>;
  listLinks(orgId: Uuid, resource: ResourceRef): Promise<FilesResult<ShareLink[]>>;
  getLink(orgId: Uuid, linkId: Uuid): Promise<FilesResult<ShareLink>>;
  revokeLink(orgId: Uuid, linkId: Uuid, now: Date): Promise<FilesResult<ShareLink>>;
  /** The link a token hash names, in whichever org. Revoked links are returned too; callers check. */
  linkByTokenHash(tokenHash: string): Promise<FilesResult<ShareLink>>;
  recordLinkOpen(orgId: Uuid, linkId: Uuid, now: Date, ipHash: string | null, uaHash: string | null): Promise<FilesResult<void>>;
  /** Is `resource` the folder `folderId` or anywhere under it? */
  withinFolder(orgId: Uuid, folderId: Uuid, resource: ResourceRef): Promise<FilesResult<boolean>>;

  /** Everything shared with this person, in any org: grants to their member id or their email as a guest. */
  sharedWith(who: Principals): Promise<FilesResult<SharedItem[]>>;
  /** Housekeeping across orgs: grants and links whose folder or document no longer exists. */
  forgetOrphans(limit: number): Promise<FilesResult<{ grants: number; links: number }>>;
}

const date = (v: unknown): Date => new Date(v as string);
const dateOrNull = (v: unknown): Date | null => (v ? new Date(v as string) : null);
const iso = (d: Date) => d.toISOString();
const fail = (message: string): FilesResult<never> => ({ ok: false, error: { kind: "internal", message } });
const notFound: FilesResult<never> = { ok: false, error: { kind: "not_found" } };

function mapGrant(r: SqlRow): Grant {
  return {
    id: r.id as string,
    orgId: r.org_id as string,
    resourceKind: r.resource_kind as ResourceKind,
    resourceId: r.resource_id as string,
    principalKind: r.principal_kind as PrincipalKind,
    principalId: r.principal_id as string,
    role: r.role as GrantRole,
    createdBy: r.created_by as string,
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
  };
}

function mapGuest(r: SqlRow): Guest {
  return {
    id: r.id as string,
    orgId: r.org_id as string,
    email: r.email as string,
    name: (r.name as string | null) ?? null,
    invitedBy: r.invited_by as string,
    invitedAt: date(r.invited_at),
    userId: (r.user_id as string | null) ?? null,
    verifiedAt: dateOrNull(r.verified_at),
    removedAt: dateOrNull(r.removed_at),
  };
}

function mapLink(r: SqlRow): ShareLink {
  return {
    id: r.id as string,
    orgId: r.org_id as string,
    resourceKind: r.resource_kind as ResourceKind,
    resourceId: r.resource_id as string,
    role: r.role as LinkRole,
    tokenHash: r.token_hash as string,
    passwordHash: (r.password_hash as string | null) ?? null,
    expiresAt: dateOrNull(r.expires_at),
    allowDownload: Number(r.allow_download) === 1,
    createdBy: r.created_by as string,
    createdAt: date(r.created_at),
    revokedAt: dateOrNull(r.revoked_at),
  };
}

// The folders above a resource ($1 = org, $2 = resource id). For a folder the chain starts
// with the folder itself; for a document, with the folder it is in.
const FOLDER_CHAIN = `WITH RECURSIVE anc(id) AS (
    SELECT id FROM files_folders WHERE org_id = $1 AND id = $2
    UNION ALL
    SELECT f.parent_id FROM files_folders f JOIN anc ON f.id = anc.id
     WHERE f.org_id = $1 AND f.parent_id IS NOT NULL
  )`;
const DOCUMENT_CHAIN = `WITH RECURSIVE anc(id) AS (
    SELECT folder_id FROM files_documents WHERE org_id = $1 AND id = $2 AND folder_id IS NOT NULL
    UNION ALL
    SELECT f.parent_id FROM files_folders f JOIN anc ON f.id = anc.id
     WHERE f.org_id = $1 AND f.parent_id IS NOT NULL
  )`;
const chainFor = (kind: ResourceKind) => (kind === "folder" ? FOLDER_CHAIN : DOCUMENT_CHAIN);
// Grants on the resource itself or on a folder in its chain ($2 = resource id, $5 = kind).
const REACHES = `g.org_id = $1
    AND ((g.resource_kind = $5 AND g.resource_id = $2)
      OR (g.resource_kind = 'folder' AND g.resource_id IN (SELECT id FROM anc)))`;
// This person's grants ($3 = member id or NULL, $4 = lower-cased email or NULL).
const MINE = `((g.principal_kind = 'member' AND $3 IS NOT NULL AND g.principal_id = $3)
      OR (g.principal_kind = 'guest' AND $4 IS NOT NULL AND g.principal_id IN (
            SELECT id FROM files_guests WHERE org_id = $1 AND email = $4 AND removed_at IS NULL)))`;

export function createSharingRepository(executor: SqlExecutor): SharingRepository {
  const rows = async (text: string, params: unknown[]) => (await executor.execute(text, params)).rows;
  const one = async (text: string, params: unknown[]) => (await rows(text, params))[0];

  return {
    async grantsReaching(orgId, resource, who) {
      try {
        const filter = who ? `AND ${MINE}` : "";
        const result = await rows(
          `${chainFor(resource.kind)}
           SELECT g.* FROM files_grants g WHERE ${REACHES} ${filter}
           ORDER BY g.created_at, g.id`,
          [orgId, resource.id, who?.memberId ?? null, who?.email?.toLowerCase() ?? null, resource.kind],
        );
        return { ok: true, value: result.map(mapGrant) };
      } catch {
        return fail("Failed to read grants");
      }
    },

    async putGrant(input) {
      try {
        const before = await one(
          `SELECT role FROM files_grants
            WHERE org_id = $1 AND resource_kind = $2 AND resource_id = $3 AND principal_kind = $4 AND principal_id = $5`,
          [input.orgId, input.resource.kind, input.resource.id, input.principalKind, input.principalId],
        );
        const row = await one(
          `INSERT INTO files_grants (id, org_id, resource_kind, resource_id, principal_kind, principal_id, role, created_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
           ON CONFLICT (org_id, resource_kind, resource_id, principal_kind, principal_id)
           DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at
           RETURNING *`,
          [input.id, input.orgId, input.resource.kind, input.resource.id, input.principalKind, input.principalId, input.role, input.createdBy, iso(input.now)],
        );
        if (!row) return fail("Failed to save grant");
        const grant = mapGrant(row);
        return { ok: true, value: { grant, created: grant.id === input.id, previousRole: (before?.role as GrantRole | undefined) ?? null } };
      } catch {
        return fail("Failed to save grant");
      }
    },

    async getGrant(orgId, grantId) {
      try {
        const row = await one(`SELECT * FROM files_grants WHERE org_id = $1 AND id = $2`, [orgId, grantId]);
        return row ? { ok: true, value: mapGrant(row) } : notFound;
      } catch {
        return fail("Failed to get grant");
      }
    },

    async deleteGrant(orgId, grantId) {
      try {
        const row = await one(`DELETE FROM files_grants WHERE org_id = $1 AND id = $2 RETURNING *`, [orgId, grantId]);
        return row ? { ok: true, value: mapGrant(row) } : notFound;
      } catch {
        return fail("Failed to delete grant");
      }
    },

    async inviteGuest(input) {
      const email = input.email.trim().toLowerCase();
      try {
        const row = await one(
          `INSERT INTO files_guests (id, org_id, email, name, invited_by, invited_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [input.id, input.orgId, email, input.name, input.invitedBy, iso(input.now)],
        );
        if (row) return { ok: true, value: { guest: mapGuest(row), created: true } };
      } catch (err) {
        if (!isUniqueViolation(err)) return fail("Failed to invite guest");
      }
      try {
        const row = await one(`SELECT * FROM files_guests WHERE org_id = $1 AND email = $2 AND removed_at IS NULL`, [input.orgId, email]);
        return row ? { ok: true, value: { guest: mapGuest(row), created: false } } : fail("Failed to invite guest");
      } catch {
        return fail("Failed to invite guest");
      }
    },

    async getGuest(orgId, guestId) {
      try {
        const row = await one(`SELECT * FROM files_guests WHERE org_id = $1 AND id = $2`, [orgId, guestId]);
        return row ? { ok: true, value: mapGuest(row) } : notFound;
      } catch {
        return fail("Failed to get guest");
      }
    },

    async listGuests(orgId) {
      try {
        const result = await rows(`SELECT * FROM files_guests WHERE org_id = $1 AND removed_at IS NULL ORDER BY email`, [orgId]);
        return { ok: true, value: result.map(mapGuest) };
      } catch {
        return fail("Failed to list guests");
      }
    },

    async verifyGuest(orgId, guestId, userId, now) {
      try {
        const row = await one(
          `UPDATE files_guests SET user_id = $3, verified_at = $4
            WHERE org_id = $1 AND id = $2 AND removed_at IS NULL AND verified_at IS NULL
           RETURNING *`,
          [orgId, guestId, userId, iso(now)],
        );
        if (row) return { ok: true, value: { guest: mapGuest(row), firstTime: true } };
        const existing = await one(`SELECT * FROM files_guests WHERE org_id = $1 AND id = $2 AND removed_at IS NULL`, [orgId, guestId]);
        return existing ? { ok: true, value: { guest: mapGuest(existing), firstTime: false } } : notFound;
      } catch {
        return fail("Failed to verify guest");
      }
    },

    async guestsForEmail(orgId, email) {
      try {
        const result = await rows(`SELECT * FROM files_guests WHERE org_id = $1 AND email = $2 AND removed_at IS NULL`, [orgId, email.trim().toLowerCase()]);
        return { ok: true, value: result.map(mapGuest) };
      } catch {
        return fail("Failed to read guests");
      }
    },

    async removeGuest(orgId, guestId, now) {
      try {
        const results = await executeBatch(executor, [
          { text: `DELETE FROM files_grants WHERE org_id = $1 AND principal_kind = 'guest' AND principal_id = $2 RETURNING id`, params: [orgId, guestId] },
          { text: `UPDATE files_guests SET removed_at = $3 WHERE org_id = $1 AND id = $2 AND removed_at IS NULL RETURNING *`, params: [orgId, guestId, iso(now)] },
        ]);
        const row = results[1]?.rows[0];
        return row ? { ok: true, value: { guest: mapGuest(row), grants: results[0]?.rows.length ?? 0 } } : notFound;
      } catch {
        return fail("Failed to remove guest");
      }
    },

    async createLink(input) {
      try {
        const row = await one(
          `INSERT INTO files_links (id, org_id, resource_kind, resource_id, role, token_hash, password_hash, expires_at, allow_download, created_by, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
          [
            input.id,
            input.orgId,
            input.resource.kind,
            input.resource.id,
            input.role,
            input.tokenHash,
            input.passwordHash,
            input.expiresAt ? iso(input.expiresAt) : null,
            input.allowDownload ? 1 : 0,
            input.createdBy,
            iso(input.now),
          ],
        );
        return row ? { ok: true, value: mapLink(row) } : fail("Failed to create link");
      } catch {
        return fail("Failed to create link");
      }
    },

    async listLinks(orgId, resource) {
      try {
        const result = await rows(
          `SELECT * FROM files_links WHERE org_id = $1 AND resource_kind = $2 AND resource_id = $3 AND revoked_at IS NULL ORDER BY created_at, id`,
          [orgId, resource.kind, resource.id],
        );
        return { ok: true, value: result.map(mapLink) };
      } catch {
        return fail("Failed to list links");
      }
    },

    async getLink(orgId, linkId) {
      try {
        const row = await one(`SELECT * FROM files_links WHERE org_id = $1 AND id = $2`, [orgId, linkId]);
        return row ? { ok: true, value: mapLink(row) } : notFound;
      } catch {
        return fail("Failed to get link");
      }
    },

    async revokeLink(orgId, linkId, now) {
      try {
        const row = await one(`UPDATE files_links SET revoked_at = $3 WHERE org_id = $1 AND id = $2 AND revoked_at IS NULL RETURNING *`, [orgId, linkId, iso(now)]);
        return row ? { ok: true, value: mapLink(row) } : notFound;
      } catch {
        return fail("Failed to revoke link");
      }
    },

    async linkByTokenHash(tokenHash) {
      try {
        // The token is the only key a link holder has; the row then names its org.
        const row = await one(`SELECT * FROM files_links WHERE token_hash = $1`, [tokenHash]);
        return row ? { ok: true, value: mapLink(row) } : notFound;
      } catch {
        return fail("Failed to read link");
      }
    },

    async recordLinkOpen(orgId, linkId, now, ipHash, uaHash) {
      try {
        await executor.execute(`INSERT INTO files_link_opens (org_id, link_id, opened_at, ip_hash, ua_hash) VALUES ($1, $2, $3, $4, $5)`, [orgId, linkId, iso(now), ipHash, uaHash]);
        return { ok: true, value: undefined };
      } catch {
        return fail("Failed to record link open");
      }
    },

    async withinFolder(orgId, folderId, resource) {
      try {
        const row = await one(`${chainFor(resource.kind)} SELECT 1 AS hit FROM anc WHERE id = $3`, [orgId, resource.id, folderId]);
        return { ok: true, value: Boolean(row) };
      } catch {
        return fail("Failed to read folder chain");
      }
    },

    async sharedWith(who) {
      if (!who.memberId && !who.email) return { ok: true, value: [] };
      try {
        // Across orgs by design: one person's grants, wherever they are. Live resources only.
        const result = await rows(
          `SELECT g.*,
                  COALESCE(d.name, f.name) AS r_name,
                  COALESCE(d.updated_at, f.updated_at) AS r_updated_at,
                  d.current_version AS d_version, d.size AS d_size, d.page_count AS d_pages, d.folder_id AS d_folder
             FROM files_grants g
             LEFT JOIN files_documents d ON g.resource_kind = 'document' AND d.org_id = g.org_id AND d.id = g.resource_id AND d.deleted_at IS NULL
             LEFT JOIN files_folders f ON g.resource_kind = 'folder' AND f.org_id = g.org_id AND f.id = g.resource_id AND f.deleted_at IS NULL
            WHERE ((g.principal_kind = 'member' AND $1 IS NOT NULL AND g.principal_id = $1)
                OR (g.principal_kind = 'guest' AND $2 IS NOT NULL AND g.principal_id IN (
                      SELECT id FROM files_guests WHERE email = $2 AND removed_at IS NULL AND org_id = g.org_id)))
              AND (d.id IS NOT NULL OR f.id IS NOT NULL)
            ORDER BY r_updated_at DESC, g.id
            LIMIT 500`,
          [who.memberId, who.email?.toLowerCase() ?? null],
        );
        return {
          ok: true,
          value: result.map((r) => ({
            grant: mapGrant(r),
            name: r.r_name as string,
            updatedAt: date(r.r_updated_at),
            document:
              r.resource_kind === "document"
                ? { currentVersion: Number(r.d_version), size: Number(r.d_size), pageCount: r.d_pages === null ? null : Number(r.d_pages), folderId: (r.d_folder as string | null) ?? null }
                : null,
          })),
        };
      } catch {
        return fail("Failed to read shared items");
      }
    },

    async forgetOrphans(limit) {
      try {
        const orphan = (table: string) => `DELETE FROM ${table} WHERE rowid IN (
            SELECT x.rowid FROM ${table} x
             WHERE (x.resource_kind = 'document' AND NOT EXISTS (SELECT 1 FROM files_documents d WHERE d.org_id = x.org_id AND d.id = x.resource_id))
                OR (x.resource_kind = 'folder' AND NOT EXISTS (SELECT 1 FROM files_folders f WHERE f.org_id = x.org_id AND f.id = x.resource_id))
             LIMIT $1) RETURNING id`;
        const results = await executeBatch(executor, [
          { text: orphan("files_grants"), params: [limit] },
          { text: orphan("files_links"), params: [limit] },
        ]);
        return { ok: true, value: { grants: results[0]?.rows.length ?? 0, links: results[1]?.rows.length ?? 0 } };
      } catch {
        return fail("Failed to forget orphans");
      }
    },
  };
}
