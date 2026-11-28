import type { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { createSqlExecutor } from "@saas/db/d1";
import { createFilesRepository, createSharingRepository, type FilesRepository, type SharingRepository } from "@saas/db/files";
import { asUuid, manifest, type Uuid } from "@saas/db";
import { d1Over, migratedDatabase, MIGRATIONS_ROOT } from "./sqlite-harness.js";

// Sharing (PW3) against a REAL SQLite engine: folder grants reach down the tree and follow a
// move, one grant per principal per resource, guests by email, links by token hash, Shared
// with me across orgs, orphan cleanup, and isolation — another org's id finds nothing.

const ORG_A = asUuid("aaaaaaaa-0000-4000-8000-00000000000a");
const ORG_B = asUuid("bbbbbbbb-0000-4000-8000-00000000000b");
const OWNER = "usr_11111111111111111111111111111111";
const VIEWER = "usr_22222222222222222222222222222222";
let seq = 0;
const id = (): Uuid => asUuid(`00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`);
const T0 = new Date("2026-11-01T10:00:00.000Z");
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

let db: DatabaseSync;
let files: FilesRepository;
let sharing: SharingRepository;

beforeEach(() => {
  db = migratedDatabase();
  const ex = createSqlExecutor(d1Over(db));
  files = createFilesRepository(ex);
  sharing = createSharingRepository(ex);
});
afterEach(() => db.close());

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};
const folder = async (org: Uuid, parentId: Uuid | null, name: string) => {
  const fid = id();
  ok(await files.createFolder({ id: fid, orgId: org, parentId, name, createdBy: OWNER, now: T0 }));
  return fid;
};
const doc = async (org: Uuid, folderId: Uuid | null, name = "Generated.pdf") => {
  const did = id();
  const sha256 = hash(name + did);
  ok(await files.createDocument({ id: did, orgId: org, folderId, name, ownerUserId: OWNER, actorKind: "user", object: { r2Key: `k/${did}`, sha256, size: 10, pageCount: 1 }, now: T0 }));
  return did;
};
const grant = (org: Uuid, kind: "folder" | "document", rid: Uuid, principalId: string, role: "editor" | "commenter" | "viewer", principalKind: "member" | "guest" = "member") =>
  sharing.putGrant({ id: id(), orgId: org, resource: { kind, id: rid }, principalKind, principalId, role, createdBy: OWNER, now: T0 });
const roles = async (org: Uuid, kind: "folder" | "document", rid: Uuid, who: { memberId: string | null; email: string | null }) =>
  ok(await sharing.grantsReaching(org, { kind, id: rid }, who)).map((g) => g.role).sort();

describe("migration 210_files_sharing", () => {
  it("is in the manifest under files, with the on-disk checksum", () => {
    const entry = manifest.migrations.find((m) => m.id === "210_files_sharing");
    expect(entry?.context).toBe("files");
    const sql = readFileSync(resolve(MIGRATIONS_ROOT, "210_files_sharing/up.sql"), "utf8");
    expect(entry?.checksum).toBe(createHash("sha256").update(sql).digest("hex"));
  });

  it("every sharing table carries org_id", () => {
    for (const t of ["files_guests", "files_grants", "files_links", "files_link_opens"]) {
      const cols = (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
      expect({ t, has: cols.includes("org_id") }).toEqual({ t, has: true });
    }
  });

  it("refuses an editor link and an unknown role", async () => {
    expect(() => db.prepare(`INSERT INTO files_links (id, org_id, resource_kind, resource_id, role, token_hash, created_by, created_at) VALUES ('x', 'o', 'document', 'd', 'editor', '${"0".repeat(64)}', 'u', 't')`).run()).toThrow();
    expect(() => db.prepare(`INSERT INTO files_grants (id, org_id, resource_kind, resource_id, principal_kind, principal_id, role, created_by, created_at, updated_at) VALUES ('x', 'o', 'document', 'd', 'member', 'u', 'owner', 'u', 't', 't')`).run()).toThrow();
  });
});

describe("grants", () => {
  it("a folder grant reaches everything under it, and the chain lists where each came from", async () => {
    const top = await folder(ORG_A, null, "Top");
    const mid = await folder(ORG_A, top, "Mid");
    const d = await doc(ORG_A, mid);
    ok(await grant(ORG_A, "folder", top, VIEWER, "viewer"));
    ok(await grant(ORG_A, "document", d, VIEWER, "commenter"));
    expect(await roles(ORG_A, "document", d, { memberId: VIEWER, email: null })).toEqual(["commenter", "viewer"]);
    expect(await roles(ORG_A, "folder", mid, { memberId: VIEWER, email: null })).toEqual(["viewer"]);
    const all = ok(await sharing.grantsReaching(ORG_A, { kind: "document", id: d }));
    expect(all.map((g) => `${g.resourceKind}:${g.resourceId === top ? "top" : "doc"}`)).toEqual(["folder:top", "document:doc"]);
    // Someone else's grants are not mine.
    expect(await roles(ORG_A, "document", d, { memberId: OWNER, email: null })).toEqual([]);
  });

  it("inherited access follows a move, with no rewrite", async () => {
    const shared = await folder(ORG_A, null, "Shared");
    const other = await folder(ORG_A, null, "Other");
    const d = await doc(ORG_A, other);
    ok(await grant(ORG_A, "folder", shared, VIEWER, "editor"));
    expect(await roles(ORG_A, "document", d, { memberId: VIEWER, email: null })).toEqual([]);
    ok(await files.moveDocument(ORG_A, d, shared, T0));
    expect(await roles(ORG_A, "document", d, { memberId: VIEWER, email: null })).toEqual(["editor"]);
    const sub = await folder(ORG_A, other, "Sub");
    ok(await files.moveFolder(ORG_A, sub, shared, T0));
    expect(await roles(ORG_A, "folder", sub, { memberId: VIEWER, email: null })).toEqual(["editor"]);
  });

  it("one grant per principal per resource: a second put changes the role", async () => {
    const d = await doc(ORG_A, null);
    const first = ok(await grant(ORG_A, "document", d, VIEWER, "viewer"));
    const second = ok(await grant(ORG_A, "document", d, VIEWER, "editor"));
    expect(first.created).toBe(true);
    expect(second).toMatchObject({ created: false, previousRole: "viewer" });
    expect(second.grant.id).toBe(first.grant.id);
    expect(await roles(ORG_A, "document", d, { memberId: VIEWER, email: null })).toEqual(["editor"]);
    ok(await sharing.deleteGrant(ORG_A, asUuid(first.grant.id)));
    expect(await roles(ORG_A, "document", d, { memberId: VIEWER, email: null })).toEqual([]);
  });
});

describe("guests", () => {
  it("are matched by email, one live record per email, and removal takes their grants", async () => {
    const d = await doc(ORG_A, null);
    const a = ok(await sharing.inviteGuest({ id: id(), orgId: ORG_A, email: " Guest@Example.com ", name: "G", invitedBy: OWNER, now: T0 }));
    const again = ok(await sharing.inviteGuest({ id: id(), orgId: ORG_A, email: "guest@example.com", name: null, invitedBy: OWNER, now: T0 }));
    expect(a.created).toBe(true);
    expect(again).toMatchObject({ created: false, guest: { id: a.guest.id, email: "guest@example.com" } });
    ok(await grant(ORG_A, "document", d, a.guest.id, "viewer", "guest"));
    expect(await roles(ORG_A, "document", d, { memberId: "usr_somebody", email: "GUEST@example.com" })).toEqual(["viewer"]);
    expect(await roles(ORG_A, "document", d, { memberId: null, email: "other@example.com" })).toEqual([]);

    const v = ok(await sharing.verifyGuest(ORG_A, asUuid(a.guest.id), "usr_guest", T0));
    expect(v.firstTime).toBe(true);
    expect(ok(await sharing.verifyGuest(ORG_A, asUuid(a.guest.id), "usr_guest", T0)).firstTime).toBe(false);

    const removed = ok(await sharing.removeGuest(ORG_A, asUuid(a.guest.id), T0));
    expect(removed.grants).toBe(1);
    expect(await roles(ORG_A, "document", d, { memberId: null, email: "guest@example.com" })).toEqual([]);
    // A removed guest can be invited afresh.
    expect(ok(await sharing.inviteGuest({ id: id(), orgId: ORG_A, email: "guest@example.com", name: null, invitedBy: OWNER, now: T0 })).created).toBe(true);
  });
});

describe("links", () => {
  it("are found by token hash, listed until revoked, and know their subtree", async () => {
    const f = await folder(ORG_A, null, "Linked");
    const inside = await doc(ORG_A, f);
    const outside = await doc(ORG_A, null);
    const link = ok(await sharing.createLink({ id: id(), orgId: ORG_A, resource: { kind: "folder", id: f }, role: "viewer", tokenHash: hash("token-1"), passwordHash: null, expiresAt: null, allowDownload: false, createdBy: OWNER, now: T0 }));
    expect(ok(await sharing.linkByTokenHash(hash("token-1")))).toMatchObject({ id: link.id, orgId: ORG_A, allowDownload: false });
    expect((await sharing.linkByTokenHash(hash("token-2"))).ok).toBe(false);
    expect(ok(await sharing.withinFolder(ORG_A, f, { kind: "document", id: inside }))).toBe(true);
    expect(ok(await sharing.withinFolder(ORG_A, f, { kind: "document", id: outside }))).toBe(false);
    expect(ok(await sharing.withinFolder(ORG_A, f, { kind: "folder", id: f }))).toBe(true);
    ok(await sharing.recordLinkOpen(ORG_A, asUuid(link.id), T0, hash("ip"), hash("ua")));
    expect(ok(await sharing.listLinks(ORG_A, { kind: "folder", id: f }))).toHaveLength(1);
    ok(await sharing.revokeLink(ORG_A, asUuid(link.id), T0));
    expect(ok(await sharing.listLinks(ORG_A, { kind: "folder", id: f }))).toHaveLength(0);
    expect(ok(await sharing.linkByTokenHash(hash("token-1"))).revokedAt).not.toBeNull();
    expect((await sharing.revokeLink(ORG_A, asUuid(link.id), T0)).ok).toBe(false);
  });
});

describe("shared with me", () => {
  it("collects member and guest grants across orgs, live resources only", async () => {
    const dA = await doc(ORG_A, null, "In A.pdf");
    const fB = await folder(ORG_B, null, "In B");
    const trashed = await doc(ORG_A, null, "Trashed.pdf");
    ok(await grant(ORG_A, "document", dA, VIEWER, "commenter"));
    ok(await grant(ORG_A, "document", trashed, VIEWER, "viewer"));
    ok(await files.trashDocument(ORG_A, trashed, T0));
    const g = ok(await sharing.inviteGuest({ id: id(), orgId: ORG_B, email: "viewer@example.com", name: null, invitedBy: OWNER, now: T0 }));
    ok(await grant(ORG_B, "folder", fB, g.guest.id, "editor", "guest"));
    const items = ok(await sharing.sharedWith({ memberId: VIEWER, email: "viewer@example.com" }));
    expect(items.map((i) => `${i.grant.orgId === ORG_A ? "A" : "B"}:${i.name}:${i.grant.role}`).sort()).toEqual(["A:In A.pdf:commenter", "B:In B:editor"]);
    expect(items.find((i) => i.name === "In A.pdf")?.document?.currentVersion).toBe(1);
    expect(ok(await sharing.sharedWith({ memberId: null, email: null }))).toEqual([]);
  });
});

describe("isolation", () => {
  it("another org's ids find nothing and change nothing", async () => {
    const f = await folder(ORG_A, null, "A");
    const d = await doc(ORG_A, f);
    const gr = ok(await grant(ORG_A, "folder", f, VIEWER, "editor"));
    const guest = ok(await sharing.inviteGuest({ id: id(), orgId: ORG_A, email: "g@example.com", name: null, invitedBy: OWNER, now: T0 }));
    const link = ok(await sharing.createLink({ id: id(), orgId: ORG_A, resource: { kind: "document", id: d }, role: "commenter", tokenHash: hash("t"), passwordHash: null, expiresAt: null, allowDownload: true, createdBy: OWNER, now: T0 }));
    const before = JSON.stringify(["files_grants", "files_guests", "files_links"].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()));

    expect(ok(await sharing.grantsReaching(ORG_B, { kind: "document", id: d }))).toEqual([]);
    expect(ok(await sharing.grantsReaching(ORG_B, { kind: "document", id: d }, { memberId: VIEWER, email: null }))).toEqual([]);
    expect((await sharing.getGrant(ORG_B, asUuid(gr.grant.id))).ok).toBe(false);
    expect((await sharing.deleteGrant(ORG_B, asUuid(gr.grant.id))).ok).toBe(false);
    expect((await sharing.getGuest(ORG_B, asUuid(guest.guest.id))).ok).toBe(false);
    expect((await sharing.verifyGuest(ORG_B, asUuid(guest.guest.id), "usr_x", T0)).ok).toBe(false);
    expect((await sharing.removeGuest(ORG_B, asUuid(guest.guest.id), T0)).ok).toBe(false);
    expect(ok(await sharing.guestsForEmail(ORG_B, "g@example.com"))).toEqual([]);
    expect(ok(await sharing.listGuests(ORG_B))).toEqual([]);
    expect((await sharing.getLink(ORG_B, asUuid(link.id))).ok).toBe(false);
    expect((await sharing.revokeLink(ORG_B, asUuid(link.id), T0)).ok).toBe(false);
    expect(ok(await sharing.listLinks(ORG_B, { kind: "document", id: d }))).toEqual([]);
    expect(ok(await sharing.withinFolder(ORG_B, f, { kind: "document", id: d }))).toBe(false);
    // A grant written under org B onto org A's folder id reaches nothing in org A.
    ok(await grant(ORG_B, "folder", f, VIEWER, "editor"));
    expect(ok(await sharing.grantsReaching(ORG_A, { kind: "document", id: d }, { memberId: VIEWER, email: null })).map((g) => g.orgId)).toEqual([ORG_A]);
    db.prepare(`DELETE FROM files_grants WHERE org_id = ?`).run(ORG_B);

    expect(JSON.stringify(["files_grants", "files_guests", "files_links"].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()))).toBe(before);
  });

  it("orphaned grants and links are forgotten once their resource is purged", async () => {
    const d = await doc(ORG_A, null);
    const keep = await doc(ORG_A, null);
    ok(await grant(ORG_A, "document", d, VIEWER, "viewer"));
    ok(await grant(ORG_A, "document", keep, VIEWER, "viewer"));
    ok(await sharing.createLink({ id: id(), orgId: ORG_A, resource: { kind: "document", id: d }, role: "viewer", tokenHash: hash("o"), passwordHash: null, expiresAt: null, allowDownload: true, createdBy: OWNER, now: T0 }));
    ok(await files.trashDocument(ORG_A, d, T0));
    ok(await files.purgeTrash(new Date(T0.getTime() + 31 * 86_400_000), 100));
    expect(ok(await sharing.forgetOrphans(100))).toEqual({ grants: 1, links: 1 });
    expect(ok(await sharing.grantsReaching(ORG_A, { kind: "document", id: keep }))).toHaveLength(1);
  });
});
