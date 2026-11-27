import type { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { createSqlExecutor } from "@saas/db/d1";
import { createFilesRepository, decodeCursor, encodeCursor, type FilesRepository, type StoredObject } from "@saas/db/files";
import { asUuid, manifest, BOUNDED_CONTEXTS, type Uuid } from "@saas/db";
import { d1Over, migratedDatabase, MIGRATIONS_ROOT } from "./sqlite-harness.js";

// The drive's repository against a REAL SQLite engine (D1 is SQLite): the
// migration, version numbering under a stale writer, the trash, uploads, and
// cross-org isolation — every method, called with another org's id, finds
// nothing and changes nothing.

const ORG_A = asUuid("aaaaaaaa-0000-4000-8000-00000000000a");
const ORG_B = asUuid("bbbbbbbb-0000-4000-8000-00000000000b");
const USER = "usr_11111111111111111111111111111111";
let seq = 0;
const id = (): Uuid => asUuid(`00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`);
const T0 = new Date("2026-11-01T10:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

function object(n: number): StoredObject {
  const sha256 = createHash("sha256").update(`generated test bytes ${n}`).digest("hex");
  return { r2Key: `org/x/doc/y/blob/${sha256}.pdf`, sha256, size: 1000 * n, pageCount: n };
}

let db: DatabaseSync;
let repo: FilesRepository;

beforeEach(() => {
  db = migratedDatabase();
  repo = createFilesRepository(createSqlExecutor(d1Over(db)));
});
afterEach(() => db.close());

const count = (table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const snapshot = () =>
  JSON.stringify(
    ["files_folders", "files_documents", "files_versions", "files_uploads"].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()),
  );

async function newDoc(org: Uuid, folderId: Uuid | null = null, name = "Generated.pdf", now = T0) {
  const docId = id();
  const r = await repo.createDocument({ id: docId, orgId: org, folderId, name, ownerUserId: USER, actorKind: "user", object: object(1), now });
  if (!r.ok) throw new Error(`createDocument: ${JSON.stringify(r.error)}`);
  return docId;
}

async function newFolder(org: Uuid, parentId: Uuid | null, name: string) {
  const folderId = id();
  const r = await repo.createFolder({ id: folderId, orgId: org, parentId, name, createdBy: USER, now: T0 });
  if (!r.ok) throw new Error(`createFolder: ${JSON.stringify(r.error)}`);
  return folderId;
}

describe("migration 200_files_core", () => {
  it("is in the manifest under the files context, with the on-disk checksum", () => {
    const entry = manifest.migrations.find((m) => m.id === "200_files_core");
    expect(entry).toBeDefined();
    expect(entry!.context).toBe("files");
    expect(BOUNDED_CONTEXTS).toContain("files");
    const sum = createHash("sha256").update(readFileSync(resolve(MIGRATIONS_ROOT, entry!.path))).digest("hex");
    expect(entry!.checksum).toBe(sum);
  });

  it("creates the four drive tables, every one carrying org_id", () => {
    for (const table of ["files_folders", "files_documents", "files_versions", "files_uploads"]) {
      const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; notnull: number }[]);
      const org = cols.find((c) => c.name === "org_id");
      expect(org?.notnull).toBe(1);
    }
  });

  it("refuses a duplicate version number at the primary key", async () => {
    const docId = await newDoc(ORG_A);
    expect(() =>
      db.prepare(
        `INSERT INTO files_versions (org_id, doc_id, version, r2_key, sha256, size, created_by, actor_kind)
         VALUES (?, ?, 1, 'k', ?, 1, 'u', 'user')`,
      ).run(ORG_A, docId, "0".repeat(64)),
    ).toThrow(/UNIQUE|PRIMARY KEY/i);
  });
});

describe("folders", () => {
  it("nest, list by parent, and refuse a duplicate live name among siblings (case-insensitive)", async () => {
    const contracts = await newFolder(ORG_A, null, "Contracts");
    await newFolder(ORG_A, contracts, "2026");
    const dup = await repo.createFolder({ id: id(), orgId: ORG_A, parentId: null, name: "contracts", createdBy: USER, now: T0 });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error.kind).toBe("conflict");
    // The same name is fine under another parent.
    expect((await repo.createFolder({ id: id(), orgId: ORG_A, parentId: contracts, name: "Contracts", createdBy: USER, now: T0 })).ok).toBe(true);

    const root = await repo.listFolder(ORG_A, null);
    expect(root.ok && root.value.folders.map((f) => f.name)).toEqual(["Contracts"]);
    const inside = await repo.listFolder(ORG_A, contracts);
    expect(inside.ok && inside.value.folders.map((f) => f.name)).toEqual(["2026", "Contracts"]);
  });

  it("will not move a folder into itself or under its own descendant", async () => {
    const a = await newFolder(ORG_A, null, "A");
    const b = await newFolder(ORG_A, a, "B");
    const c = await newFolder(ORG_A, b, "C");
    for (const target of [a, c]) {
      const r = await repo.moveFolder(ORG_A, a, target, at(1));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe("invalid_move");
    }
    const ok = await repo.moveFolder(ORG_A, c, null, at(1));
    expect(ok.ok && ok.value.parentId).toBeNull();
  });

  it("a parent must be live: no folder or document goes into a trashed folder", async () => {
    const gone = await newFolder(ORG_A, null, "Gone");
    await repo.trashFolder(ORG_A, gone, at(1));
    const f = await repo.createFolder({ id: id(), orgId: ORG_A, parentId: gone, name: "x", createdBy: USER, now: at(2) });
    expect(!f.ok && f.error.kind).toBe("not_found");
    const d = await repo.createDocument({ id: id(), orgId: ORG_A, folderId: gone, name: "x.pdf", ownerUserId: USER, actorKind: "user", object: object(1), now: at(2) });
    expect(!d.ok && d.error.kind).toBe("not_found");
    expect(count("files_documents")).toBe(0);
    expect(count("files_versions")).toBe(0);
  });
});

describe("documents and versions", () => {
  it("an upload is document + version 1, atomically", async () => {
    const docId = await newDoc(ORG_A);
    const doc = await repo.getDocument(ORG_A, docId);
    expect(doc.ok && doc.value.currentVersion).toBe(1);
    const versions = await repo.listVersions(ORG_A, docId);
    expect(versions.ok && versions.value.map((v) => v.version)).toEqual([1]);
  });

  it("a save on the current base is the next version; a stale base is version_conflict and changes nothing", async () => {
    const docId = await newDoc(ORG_A);
    const v2 = await repo.addVersion({ orgId: ORG_A, docId, baseVersion: 1, createdBy: USER, actorKind: "user", object: object(2), now: at(1) });
    expect(v2.ok).toBe(true);
    if (v2.ok) {
      expect(v2.value.version.version).toBe(2);
      expect(v2.value.document.currentVersion).toBe(2);
      expect(v2.value.document.size).toBe(2000);
      expect(v2.value.document.pageCount).toBe(2);
    }

    const before = snapshot();
    const stale = await repo.addVersion({ orgId: ORG_A, docId, baseVersion: 1, createdBy: USER, actorKind: "agent", object: object(3), now: at(2) });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error).toEqual({ kind: "version_conflict", currentVersion: 2 });
    expect(snapshot()).toBe(before);
  });

  it("two writers on the same base: exactly one wins", async () => {
    const docId = await newDoc(ORG_A);
    const results = await Promise.all(
      [2, 3].map((n) => repo.addVersion({ orgId: ORG_A, docId, baseVersion: 1, createdBy: USER, actorKind: "user", object: object(n), now: at(n) })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.error.kind === "version_conflict")).toHaveLength(1);
    expect(count("files_versions")).toBe(2);
  });

  it("a restore is a new version pointing at the old object, counted once in usage", async () => {
    const docId = await newDoc(ORG_A);
    await repo.addVersion({ orgId: ORG_A, docId, baseVersion: 1, createdBy: USER, actorKind: "user", object: object(2), now: at(1) });
    const v1 = await repo.getVersion(ORG_A, docId, 1);
    if (!v1.ok) throw new Error("v1");
    const restored = await repo.addVersion({
      orgId: ORG_A, docId, baseVersion: 2, createdBy: USER, actorKind: "user", restoredFrom: 1, now: at(2),
      object: { r2Key: v1.value.r2Key, sha256: v1.value.sha256, size: v1.value.size, pageCount: v1.value.pageCount },
    });
    expect(restored.ok && restored.value.version).toMatchObject({ version: 3, restoredFrom: 1, r2Key: v1.value.r2Key });
    const usage = await repo.usage(ORG_A);
    expect(usage.ok && usage.value).toEqual({ storageBytes: 1000 + 2000, documents: 1, versions: 3 });
  });

  it("records provenance for agent-made versions", async () => {
    const docId = await newDoc(ORG_A);
    const r = await repo.addVersion({
      orgId: ORG_A, docId, baseVersion: 1, createdBy: USER, actorKind: "agent", now: at(1), object: object(2),
      provenance: { conversationId: "cnv_x", tools: ["page_rotate"] },
    });
    expect(r.ok && r.value.version.provenance).toEqual({ conversationId: "cnv_x", tools: ["page_rotate"] });
  });

  it("recent documents page by updated time with an opaque cursor", async () => {
    for (let i = 0; i < 5; i++) await newDoc(ORG_A, null, `Doc ${i}.pdf`, at(i));
    const first = await repo.listRecent(ORG_A, { limit: 2 });
    if (!first.ok) throw new Error("page 1");
    expect(first.value.items.map((d) => d.name)).toEqual(["Doc 4.pdf", "Doc 3.pdf"]);
    const second = await repo.listRecent(ORG_A, { limit: 2, cursor: first.value.nextCursor });
    if (!second.ok) throw new Error("page 2");
    expect(second.value.items.map((d) => d.name)).toEqual(["Doc 2.pdf", "Doc 1.pdf"]);
    const third = await repo.listRecent(ORG_A, { limit: 2, cursor: second.value.nextCursor });
    expect(third.ok && third.value).toMatchObject({ nextCursor: null });
    expect(decodeCursor(encodeCursor("2026-11-01T10:00:00.000Z", "x"))).toEqual({ updatedAt: "2026-11-01T10:00:00.000Z", id: "x" });
    expect(decodeCursor("not a cursor")).toBeNull();
  });
});

describe("trash", () => {
  it("trashing a folder takes its subtree; restoring brings back exactly that subtree", async () => {
    const top = await newFolder(ORG_A, null, "Top");
    const sub = await newFolder(ORG_A, top, "Sub");
    const inTop = await newDoc(ORG_A, top, "in-top.pdf");
    const inSub = await newDoc(ORG_A, sub, "in-sub.pdf");
    // Trashed on its own, earlier: it must stay trashed when Top comes back.
    const alone = await newDoc(ORG_A, sub, "alone.pdf");
    await repo.trashDocument(ORG_A, alone, at(1));

    await repo.trashFolder(ORG_A, top, at(2));
    for (const d of [inTop, inSub]) {
      const r = await repo.getDocument(ORG_A, d);
      expect(r.ok && r.value.deletedAt?.toISOString()).toBe(at(2).toISOString());
    }
    const trash = await repo.listTrash(ORG_A);
    // The top of each trashed set only.
    expect(trash.ok && trash.value.map((e) => `${e.kind}:${e.name}`)).toEqual(["folder:Top", "document:alone.pdf"]);

    const back = await repo.restoreFolder(ORG_A, top, at(3));
    expect(back.ok && back.value.deletedAt).toBeNull();
    for (const d of [inTop, inSub]) {
      const r = await repo.getDocument(ORG_A, d);
      expect(r.ok && r.value.deletedAt).toBeNull();
    }
    const stillGone = await repo.getDocument(ORG_A, alone);
    expect(stillGone.ok && stillGone.value.deletedAt?.toISOString()).toBe(at(1).toISOString());
  });

  it("a document whose folder is gone is restored to the root", async () => {
    const f = await newFolder(ORG_A, null, "F");
    const d = await newDoc(ORG_A, f);
    await repo.trashDocument(ORG_A, d, at(1));
    await repo.trashFolder(ORG_A, f, at(2));
    const r = await repo.restoreDocument(ORG_A, d, at(3));
    expect(r.ok && r.value).toMatchObject({ folderId: null, deletedAt: null });
  });

  it("the sweep removes what was trashed before the cutoff, returns its R2 keys, and leaves the rest", async () => {
    const f = await newFolder(ORG_A, null, "Old");
    const old = await newDoc(ORG_A, f, "old.pdf");
    await repo.addVersion({ orgId: ORG_A, docId: old, baseVersion: 1, createdBy: USER, actorKind: "user", object: object(2), now: at(1) });
    await repo.trashFolder(ORG_A, f, at(2));
    const recent = await newDoc(ORG_B, null, "recent.pdf");
    await repo.trashDocument(ORG_B, recent, at(100));
    const live = await newDoc(ORG_A, null, "live.pdf");

    const r = await repo.purgeTrash(at(50), 100);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.documents).toBe(1);
    expect(r.value.folders).toBe(1);
    expect(r.value.r2Keys.sort()).toEqual([object(1).r2Key, object(2).r2Key].sort());
    expect((await repo.getDocument(ORG_A, old)).ok).toBe(false);
    expect((await repo.getDocument(ORG_B, recent)).ok).toBe(true);
    expect((await repo.getDocument(ORG_A, live)).ok).toBe(true);
    expect((await repo.listVersions(ORG_A, live)).ok).toBe(true);
  });
});

describe("multipart uploads", () => {
  it("parts recorded concurrently are all kept, and a completed upload takes no more", async () => {
    const uploadId = id();
    await repo.createUpload({
      id: uploadId, orgId: ORG_A, docId: null, folderId: null, name: "big.pdf", r2Key: "org/x/tmp/y",
      r2UploadId: "r2-upload", baseVersion: null, createdBy: USER, now: T0, expiresAt: at(60),
    });
    await Promise.all([3, 1, 2].map((n) => repo.recordUploadPart(ORG_A, uploadId, { partNumber: n, etag: `e${n}` })));
    // A retried part replaces its etag, never duplicates.
    await repo.recordUploadPart(ORG_A, uploadId, { partNumber: 2, etag: "e2-retry" });
    const u = await repo.getUpload(ORG_A, uploadId);
    expect(u.ok && u.value.parts).toEqual([
      { partNumber: 1, etag: "e1" },
      { partNumber: 2, etag: "e2-retry" },
      { partNumber: 3, etag: "e3" },
    ]);
    expect((await repo.completeUpload(ORG_A, uploadId, at(5))).ok).toBe(true);
    expect((await repo.recordUploadPart(ORG_A, uploadId, { partNumber: 4, etag: "e4" })).ok).toBe(false);
    expect((await repo.completeUpload(ORG_A, uploadId, at(6))).ok).toBe(false);
  });

  it("unfinished uploads past expiry are found for the cron, and forgotten", async () => {
    const stale = id();
    const done = id();
    for (const [u, exp] of [[stale, at(10)], [done, at(10)]] as const) {
      await repo.createUpload({ id: u, orgId: ORG_A, docId: null, folderId: null, name: "x.pdf", r2Key: "k", r2UploadId: "r", baseVersion: null, createdBy: USER, now: T0, expiresAt: exp });
    }
    await repo.completeUpload(ORG_A, done, at(5));
    const expired = await repo.expiredUploads(at(20), 10);
    expect(expired.ok && expired.value.map((u) => u.id)).toEqual([stale]);
    await repo.forgetUpload(ORG_A, stale);
    expect((await repo.getUpload(ORG_A, stale)).ok).toBe(false);
  });
});

describe("cross-org isolation", () => {
  it("every method called with another org's id finds nothing and changes nothing", async () => {
    const folder = await newFolder(ORG_A, null, "A's folder");
    const trashedFolder = await newFolder(ORG_A, null, "A's trashed folder");
    await repo.trashFolder(ORG_A, trashedFolder, at(1));
    const doc = await newDoc(ORG_A, folder, "A's doc.pdf");
    const trashedDoc = await newDoc(ORG_A, null, "A's trashed doc.pdf");
    await repo.trashDocument(ORG_A, trashedDoc, at(1));
    const upload = id();
    await repo.createUpload({ id: upload, orgId: ORG_A, docId: doc, folderId: null, name: "u.pdf", r2Key: "k", r2UploadId: "r", baseVersion: 1, createdBy: USER, now: T0, expiresAt: at(60) });

    const before = snapshot();
    const t = at(10);
    const attempts: Array<[string, Promise<{ ok: boolean; error?: { kind: string } }>]> = [
      ["getFolder", repo.getFolder(ORG_B, folder)],
      ["renameFolder", repo.renameFolder(ORG_B, folder, "mine now", t)],
      ["moveFolder", repo.moveFolder(ORG_B, folder, null, t)],
      ["trashFolder", repo.trashFolder(ORG_B, folder, t)],
      ["restoreFolder", repo.restoreFolder(ORG_B, trashedFolder, t)],
      ["listFolder", repo.listFolder(ORG_B, folder)],
      ["createFolder under A's folder", repo.createFolder({ id: id(), orgId: ORG_B, parentId: folder, name: "x", createdBy: USER, now: t })],
      ["createDocument in A's folder", repo.createDocument({ id: id(), orgId: ORG_B, folderId: folder, name: "x.pdf", ownerUserId: USER, actorKind: "user", object: object(1), now: t })],
      ["getDocument", repo.getDocument(ORG_B, doc)],
      ["renameDocument", repo.renameDocument(ORG_B, doc, "mine.pdf", t)],
      ["moveDocument", repo.moveDocument(ORG_B, doc, null, t)],
      ["trashDocument", repo.trashDocument(ORG_B, doc, t)],
      ["restoreDocument", repo.restoreDocument(ORG_B, trashedDoc, t)],
      ["addVersion", repo.addVersion({ orgId: ORG_B, docId: doc, baseVersion: 1, createdBy: USER, actorKind: "user", object: object(9), now: t })],
      ["getVersion", repo.getVersion(ORG_B, doc, 1)],
      ["listVersions", repo.listVersions(ORG_B, doc)],
      ["getUpload", repo.getUpload(ORG_B, upload)],
      ["recordUploadPart", repo.recordUploadPart(ORG_B, upload, { partNumber: 1, etag: "e" })],
      ["completeUpload", repo.completeUpload(ORG_B, upload, t)],
    ];
    for (const [name, p] of attempts) {
      const r = await p;
      expect({ name, ok: r.ok, kind: r.error?.kind }).toEqual({ name, ok: false, kind: "not_found" });
    }
    // A move of B's own folder under A's folder is refused too.
    const bFolder = await newFolder(ORG_B, null, "B's folder");
    const bMove = await repo.moveFolder(ORG_B, bFolder, folder, t);
    expect(bMove.ok).toBe(false);
    const bDoc = await newDoc(ORG_B, null, "B's doc.pdf");
    expect((await repo.moveDocument(ORG_B, bDoc, folder, t)).ok).toBe(false);
    await repo.forgetUpload(ORG_B, upload);

    // B's own reads see none of A's rows.
    const root = await repo.listFolder(ORG_B, null);
    expect(root.ok && [...root.value.folders, ...root.value.documents].map((x) => x.name).sort()).toEqual(["B's doc.pdf", "B's folder"]);
    const recent = await repo.listRecent(ORG_B, { limit: 50 });
    expect(recent.ok && recent.value.items.map((d) => d.name)).toEqual(["B's doc.pdf"]);
    expect((await repo.listTrash(ORG_B)).ok && ((await repo.listTrash(ORG_B)) as { value: unknown[] }).value).toEqual([]);
    const usage = await repo.usage(ORG_B);
    expect(usage.ok && usage.value).toEqual({ storageBytes: 1000, documents: 1, versions: 1 });

    // A's rows are exactly as they were (B's own rows aside).
    const aRows = JSON.stringify(
      ["files_folders", "files_documents", "files_versions", "files_uploads"].map((tb) =>
        db.prepare(`SELECT * FROM ${tb} WHERE org_id = ? ORDER BY 1, 2`).all(ORG_A),
      ),
    );
    const aBefore = JSON.stringify(
      (JSON.parse(before) as Array<Array<{ org_id: string }>>).map((rows) => rows.filter((r) => r.org_id === ORG_A)),
    );
    expect(aRows).toBe(aBefore);
  });
});
