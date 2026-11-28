import { FILES_ENTITLEMENTS, FILES_FREE_TIER } from "@saas/contracts/files";
import { toPublic } from "@files-worker/ids";
import { looksLikePdf } from "@files-worker/store";
import { fixturePdf, sha256, snapshot, world, type World } from "./harness.js";

// Every drive route through the worker's real router, on real SQLite and an
// in-memory R2. The PDFs are generated here; none is a real document.

const ORG_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const ORG_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const A = `/v1/organizations/${toPublic("org", ORG_A)}`;
const B = `/v1/organizations/${toPublic("org", ORG_B)}`;
const ALICE = "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; // owner of A
const VERA = "usr_cccccccccccccccccccccccccccccccc"; // viewer of A
const BOB = "usr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"; // owner of B

type Json = { data: Record<string, any>; error?: { code: string; message: string; details: Record<string, unknown> } }; // eslint-disable-line @typescript-eslint/no-explicit-any
const json = async (res: Response) => (await res.json()) as Json;

function setup(limits?: Record<string, number | null>): World {
  const w = world(limits);
  w.directory.add(ALICE, ORG_A, "owner");
  w.directory.add(VERA, ORG_A, "viewer");
  w.directory.add(BOB, ORG_B, "owner");
  return w;
}

/** A minimal WebP: the RIFF/WEBP header and a few bytes (enough for the magic-byte check). */
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x0c, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);

async function upload(w: World, name = "Generated.pdf", pdf = fixturePdf(2), folderId?: string, user = ALICE, base = A) {
  const q = new URLSearchParams({ name, ...(folderId ? { folderId } : {}) });
  const res = await w.request("POST", `${base}/documents?${q}`, { user, body: pdf, headers: { "content-type": "application/pdf", "x-pagewell-page-count": "2" } });
  return { res, body: await json(res) };
}

async function save(w: World, docId: string, base: number, pdf: Uint8Array, user = ALICE) {
  const res = await w.request("POST", `${A}/documents/${docId}/versions`, { user, body: pdf, headers: { "content-type": "application/pdf", "x-pagewell-base-version": String(base) } });
  return { res, body: await json(res) };
}

async function contentOf(w: World, docId: string, version?: number, base = A, user = ALICE) {
  const res = await w.request("GET", `${base}/documents/${docId}/content${version ? `?version=${version}` : ""}`, { user });
  return { res, bytes: res.ok ? new Uint8Array(await res.arrayBuffer()) : null };
}

describe("the drive, end to end", () => {
  it("upload → open → save v2 → stale save is 409 → restore v1 as v3", async () => {
    const w = setup();
    const v1 = fixturePdf(2, "v1");
    const up = await upload(w, "Lease.pdf", v1);
    expect(up.res.status).toBe(201);
    const doc = up.body.data.document;
    expect(doc).toMatchObject({ name: "Lease.pdf", currentVersion: 1, size: v1.byteLength, pageCount: 2 });
    expect(doc.id).toMatch(/^doc_[0-9a-f]{32}$/);
    expect(up.body.data.version).toMatchObject({ version: 1, sha256: sha256(v1), actorKind: "user" });
    // The bytes landed under the org's prefix and nowhere else.
    expect([...w.bucket.objects.keys()]).toEqual([expect.stringMatching(new RegExp(`^org/${ORG_A}/doc/[0-9a-f-]{36}/blob/[0-9a-f-]{36}\\.pdf$`))]);

    const opened = await contentOf(w, doc.id);
    expect(opened.res.headers.get("content-type")).toBe("application/pdf");
    expect(opened.res.headers.get("x-pagewell-version")).toBe("1");
    expect(sha256(opened.bytes!)).toBe(sha256(v1));

    const v2 = fixturePdf(3, "v2");
    const saved = await save(w, doc.id, 1, v2);
    expect(saved.res.status).toBe(201);
    expect(saved.body.data.document).toMatchObject({ currentVersion: 2, size: v2.byteLength });

    const before = snapshot(w);
    const stale = await save(w, doc.id, 1, fixturePdf(1, "stale"));
    expect(stale.res.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: "version_conflict", details: { currentVersion: 2 } });
    expect(snapshot(w)).toBe(before); // nothing stored, nothing recorded

    const restored = await w.request("POST", `${A}/documents/${doc.id}/versions/1/restore`, { user: ALICE });
    expect(restored.status).toBe(201);
    expect((await json(restored)).data.version).toMatchObject({ version: 3, restoredFrom: 1, sha256: sha256(v1) });
    expect(sha256((await contentOf(w, doc.id)).bytes!)).toBe(sha256(v1));
    expect(sha256((await contentOf(w, doc.id, 2)).bytes!)).toBe(sha256(v2));

    const versions = await json(await w.request("GET", `${A}/documents/${doc.id}/versions`, { user: ALICE }));
    expect(versions.data.versions.map((v: { version: number }) => v.version)).toEqual([3, 2, 1]);
    // A restore points at v1's object: three versions, two objects.
    expect(w.bucket.objects.size).toBe(2);
    const quota = await json(await w.request("GET", `${A}/quota`, { user: ALICE }));
    expect(quota.data.quota.storageBytes.used).toBe(v1.byteLength + v2.byteLength);
  });

  it("a numbered version is cacheable for good and answers If-None-Match; the current one revalidates", async () => {
    const w = setup();
    const { body } = await upload(w);
    const id = body.data.document.id;
    const numbered = await contentOf(w, id, 1);
    expect(numbered.res.headers.get("cache-control")).toContain("immutable");
    const current = await contentOf(w, id);
    expect(current.res.headers.get("cache-control")).toBe("private, no-cache");
    const again = await w.request("GET", `${A}/documents/${id}/content?version=1`, { user: ALICE, headers: { "if-none-match": numbered.res.headers.get("etag")! } });
    expect(again.status).toBe(304);
  });

  it("refuses what is not a PDF, an empty body and a missing base version", async () => {
    const w = setup();
    const notPdf = await upload(w, "notes.pdf", new TextEncoder().encode("just some generated text, not a PDF"));
    expect(notPdf.res.status).toBe(415);
    expect(notPdf.body.error?.code).toBe("not_a_pdf");
    expect((await upload(w, "empty.pdf", new Uint8Array())).res.status).toBe(422);
    const { body } = await upload(w);
    const noBase = await w.request("POST", `${A}/documents/${body.data.document.id}/versions`, { user: ALICE, body: fixturePdf(1), headers: { "content-type": "application/pdf" } });
    expect(noBase.status).toBe(422);
    expect(w.bucket.objects.size).toBe(1);
    expect(looksLikePdf(new TextEncoder().encode("\n\n%PDF-1.4"))).toBe(true);
  });

  it("folders nest, list with a breadcrumb, refuse a sibling's name and a move into themselves", async () => {
    const w = setup();
    const mk = async (name: string, parentId?: string) => json(await w.request("POST", `${A}/folders`, { user: ALICE, json: { name, parentId } }));
    const contracts = (await mk("Contracts")).data.folder;
    const y2026 = (await mk("2026", contracts.id)).data.folder;
    const dup = await w.request("POST", `${A}/folders`, { user: ALICE, json: { name: "contracts" } });
    expect(dup.status).toBe(409);
    await upload(w, "In 2026.pdf", fixturePdf(1), y2026.id);

    const listing = await json(await w.request("GET", `${A}/folders/${y2026.id}`, { user: ALICE }));
    expect(listing.data.breadcrumb.map((b: { name: string }) => b.name)).toEqual(["Contracts", "2026"]);
    expect(listing.data.documents.map((d: { name: string }) => d.name)).toEqual(["In 2026.pdf"]);
    const root = await json(await w.request("GET", `${A}/folders`, { user: ALICE }));
    expect(root.data).toMatchObject({ folder: null, breadcrumb: [] });
    expect(root.data.folders.map((f: { name: string }) => f.name)).toEqual(["Contracts"]);

    const loop = await w.request("PATCH", `${A}/folders/${contracts.id}`, { user: ALICE, json: { parentId: y2026.id } });
    expect(loop.status).toBe(422);
    expect((await json(loop)).error?.code).toBe("invalid_move");
    const renamed = await json(await w.request("PATCH", `${A}/folders/${y2026.id}`, { user: ALICE, json: { name: "Year 2026" } }));
    expect(renamed.data.folder.name).toBe("Year 2026");
    expect((await w.request("POST", `${A}/folders`, { user: ALICE, json: { name: "a/b" } })).status).toBe(422);
  });

  it("trash: a folder takes its contents; restore brings them back; documents rename and move", async () => {
    const w = setup();
    const folder = (await json(await w.request("POST", `${A}/folders`, { user: ALICE, json: { name: "Old" } }))).data.folder;
    const inside = (await upload(w, "inside.pdf", fixturePdf(1), folder.id)).body.data.document;
    const loose = (await upload(w, "loose.pdf")).body.data.document;

    expect((await w.request("DELETE", `${A}/folders/${folder.id}`, { user: ALICE })).status).toBe(200);
    expect((await w.request("DELETE", `${A}/documents/${loose.id}`, { user: ALICE })).status).toBe(200);
    expect((await contentOf(w, inside.id)).res.status).toBe(404);
    const trash = await json(await w.request("GET", `${A}/trash`, { user: ALICE }));
    expect(trash.data.entries.map((e: { kind: string; name: string }) => `${e.kind}:${e.name}`).sort()).toEqual(["document:loose.pdf", "folder:Old"]);
    const purgeAt = new Date(trash.data.entries[0].purgeAt).getTime() - new Date(trash.data.entries[0].deletedAt).getTime();
    expect(purgeAt).toBe(30 * 86_400_000);

    expect((await w.request("POST", `${A}/folders/${folder.id}/restore`, { user: ALICE })).status).toBe(200);
    expect((await contentOf(w, inside.id)).res.status).toBe(200);
    expect((await w.request("POST", `${A}/documents/${loose.id}/restore`, { user: ALICE })).status).toBe(200);

    const moved = await json(await w.request("PATCH", `${A}/documents/${loose.id}`, { user: ALICE, json: { name: "Renamed.pdf", folderId: folder.id } }));
    expect(moved.data.document).toMatchObject({ name: "Renamed.pdf", folderId: folder.id });
    const recent = await json(await w.request("GET", `${A}/documents?limit=1`, { user: ALICE }));
    expect(recent.data.documents).toHaveLength(1);
    expect(recent.data.nextCursor).toEqual(expect.any(String));
  });

  it("the cron purges what has been in the trash 30 days, with every object under it, and aborts expired uploads", async () => {
    const w = setup();
    const gone = (await upload(w, "gone.pdf")).body.data.document;
    await save(w, gone.id, 1, fixturePdf(3));
    await w.request("PUT", `${A}/documents/${gone.id}/versions/1/thumbnail`, { user: ALICE, body: WEBP, headers: { "content-type": "image/webp" } });
    const kept = (await upload(w, "kept.pdf")).body.data.document;
    await w.request("DELETE", `${A}/documents/${gone.id}`, { user: ALICE });
    const started = await json(await w.request("POST", `${A}/uploads`, { user: ALICE, json: { name: "never finished.pdf", size: 10 } }));
    expect(started.data.upload.id).toMatch(/^upl_/);
    expect(w.bucket.objects.size).toBe(4);

    const tooSoon = await w.sweep(new Date(w.now.getTime() + 29 * 86_400_000));
    expect(tooSoon).toEqual({ documents: 0, folders: 0, objects: 0, uploads: 1 });
    expect(w.bucket.uploads.size).toBe(0);
    const due = await w.sweep(new Date(w.now.getTime() + 31 * 86_400_000));
    expect(due).toMatchObject({ documents: 1, objects: 3 });
    expect([...w.bucket.objects.keys()].every((k) => !k.includes(gone.id.slice(4, 12)))).toBe(true);
    expect((await contentOf(w, kept.id)).res.status).toBe(200);
  });

  it("thumbnails and extracted text are stored per version", async () => {
    const w = setup();
    const doc = (await upload(w)).body.data.document;
    const thumb = WEBP;
    expect((await w.request("PUT", `${A}/documents/${doc.id}/versions/1/thumbnail`, { user: ALICE, body: thumb, headers: { "content-type": "image/webp" } })).status).toBe(204);
    // The bytes must be the image the type claims: HTML labelled image/png is refused (PW-26).
    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    expect((await w.request("PUT", `${A}/documents/${doc.id}/versions/1/thumbnail`, { user: ALICE, body: html, headers: { "content-type": "image/png" } })).status).toBe(415);
    expect((await w.request("PUT", `${A}/documents/${doc.id}/versions/1/thumbnail`, { user: ALICE, body: WEBP, headers: { "content-type": "image/png" } })).status).toBe(415);
    const got = await w.request("GET", `${A}/documents/${doc.id}/versions/1/thumbnail`, { user: ALICE });
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(thumb);
    expect((await w.request("PUT", `${A}/documents/${doc.id}/versions/1/thumbnail`, { user: ALICE, body: thumb, headers: { "content-type": "text/html" } })).status).toBe(415);
    const text = JSON.stringify({ pages: [{ page: 1, text: "Generated page 1." }] });
    expect((await w.request("PUT", `${A}/documents/${doc.id}/versions/1/text`, { user: ALICE, body: text, headers: { "content-type": "application/json" } })).status).toBe(204);
    expect((await w.request("PUT", `${A}/documents/${doc.id}/versions/9/text`, { user: ALICE, body: text, headers: { "content-type": "application/json" } })).status).toBe(404);
  });
});

describe("multipart uploads", () => {
  function split(pdf: Uint8Array, parts: number) {
    const size = Math.ceil(pdf.byteLength / parts);
    return Array.from({ length: parts }, (_, i) => pdf.subarray(i * size, (i + 1) * size));
  }

  it("parts (sent out of order) complete into a new document, checked against the sha256", async () => {
    const w = setup();
    const pdf = fixturePdf(40, "multipart");
    const started = await json(await w.request("POST", `${A}/uploads`, { user: ALICE, json: { name: "Big.pdf", size: pdf.byteLength } }));
    const id = started.data.upload.id;
    const parts = split(pdf, 3);
    for (const n of [3, 1, 2]) {
      const r = await w.request("PUT", `${A}/uploads/${id}/parts/${n}`, { user: ALICE, body: parts[n - 1]! });
      expect(r.status).toBe(200);
    }
    const done = await w.request("POST", `${A}/uploads/${id}/complete`, { user: ALICE, json: { sha256: sha256(pdf), pageCount: 40 } });
    expect(done.status).toBe(201);
    const doc = (await json(done)).data.document;
    expect(doc).toMatchObject({ name: "Big.pdf", currentVersion: 1, size: pdf.byteLength, pageCount: 40 });
    expect(sha256((await contentOf(w, doc.id)).bytes!)).toBe(sha256(pdf));
    // Completed: no more parts, no second completion.
    expect((await w.request("PUT", `${A}/uploads/${id}/parts/4`, { user: ALICE, body: parts[0]! })).status).toBe(404);
  });

  it("a multipart save is the next version, and a mismatched sha256 stores nothing", async () => {
    const w = setup();
    const doc = (await upload(w)).body.data.document;
    const pdf = fixturePdf(5, "v2 by parts");
    const start = async () => (await json(await w.request("POST", `${A}/uploads`, { user: ALICE, json: { name: "x.pdf", size: pdf.byteLength, docId: doc.id, baseVersion: 1 } }))).data.upload.id;

    const bad = await start();
    await w.request("PUT", `${A}/uploads/${bad}/parts/1`, { user: ALICE, body: pdf });
    const before = w.bucket.objects.size;
    const mismatch = await w.request("POST", `${A}/uploads/${bad}/complete`, { user: ALICE, json: { sha256: "0".repeat(64) } });
    expect(mismatch.status).toBe(422);
    expect(w.bucket.objects.size).toBe(before);

    const good = await start();
    await w.request("PUT", `${A}/uploads/${good}/parts/1`, { user: ALICE, body: pdf });
    const done = await w.request("POST", `${A}/uploads/${good}/complete`, { user: ALICE, json: { sha256: sha256(pdf) } });
    expect(done.status).toBe(201);
    expect((await json(done)).data.version.version).toBe(2);
  });

  it("refuses a first part that is not a PDF, and a save upload on a stale base", async () => {
    const w = setup();
    const started = await json(await w.request("POST", `${A}/uploads`, { user: ALICE, json: { name: "x.pdf", size: 100 } }));
    const r = await w.request("PUT", `${A}/uploads/${started.data.upload.id}/parts/1`, { user: ALICE, body: new TextEncoder().encode("generated text") });
    expect(r.status).toBe(415);
    const doc = (await upload(w)).body.data.document;
    await save(w, doc.id, 1, fixturePdf(1));
    const stale = await w.request("POST", `${A}/uploads`, { user: ALICE, json: { name: "x.pdf", size: 100, docId: doc.id, baseVersion: 1 } });
    expect(stale.status).toBe(409);
    expect((await w.request("DELETE", `${A}/uploads/${started.data.upload.id}`, { user: ALICE })).status).toBe(204);
    expect(w.bucket.uploads.size).toBe(0);
  });
});

describe("quotas", () => {
  it("the file-size limit refuses a large upload with 402, before anything is stored", async () => {
    const w = setup({ [FILES_ENTITLEMENTS.MAX_FILE_BYTES]: 1000 });
    const r = await upload(w, "big.pdf", fixturePdf(20));
    expect(r.res.status).toBe(402);
    expect(r.body.error).toMatchObject({ code: "quota_exceeded", details: { quota: "file_size", limit: 1000 } });
    expect(w.bucket.objects.size).toBe(0);
    const multipart = await w.request("POST", `${A}/uploads`, { user: ALICE, json: { name: "big.pdf", size: 5000 } });
    expect(multipart.status).toBe(402);
  });

  it("the storage limit counts every version", async () => {
    const one = fixturePdf(1);
    const w = setup({ [FILES_ENTITLEMENTS.STORAGE_BYTES]: one.byteLength * 2 + 10 });
    const doc = (await upload(w, "a.pdf", one)).body.data.document;
    expect((await save(w, doc.id, 1, fixturePdf(1, "x"))).res.status).toBe(201);
    const full = await save(w, doc.id, 2, fixturePdf(1, "y"));
    expect(full.res.status).toBe(402);
    expect(full.body.error?.details).toMatchObject({ quota: "storage" });
  });

  it("the version limit stops saves and restores", async () => {
    const w = setup({ [FILES_ENTITLEMENTS.VERSIONS_PER_DOCUMENT]: 2 });
    const doc = (await upload(w)).body.data.document;
    expect((await save(w, doc.id, 1, fixturePdf(1, "2"))).res.status).toBe(201);
    expect((await save(w, doc.id, 2, fixturePdf(1, "3"))).res.status).toBe(402);
    expect((await w.request("POST", `${A}/documents/${doc.id}/versions/1/restore`, { user: ALICE })).status).toBe(402);
  });

  it("a plan without drive limits gets the free tier, and an unlimited plan says so", async () => {
    const free = setup();
    const q = await json(await free.request("GET", `${A}/quota`, { user: ALICE }));
    expect(q.data.quota).toEqual({ storageBytes: { used: 0, limit: FILES_FREE_TIER.storageBytes }, maxFileBytes: FILES_FREE_TIER.maxFileBytes, maxVersionsPerDocument: FILES_FREE_TIER.versionsPerDocument });
    const unlimited = setup({ [FILES_ENTITLEMENTS.STORAGE_BYTES]: null });
    const u = await json(await unlimited.request("GET", `${A}/quota`, { user: ALICE }));
    expect(u.data.quota.storageBytes.limit).toBeNull();
  });
});

describe("rights in the org", () => {
  it("a viewer reads but cannot upload, save, rename or delete; each refusal is a 404", async () => {
    const w = setup();
    const doc = (await upload(w)).body.data.document;
    expect((await contentOf(w, doc.id, undefined, A, VERA)).res.status).toBe(200);
    const before = snapshot(w);
    const tries = [
      await upload(w, "v.pdf", fixturePdf(1), undefined, VERA).then((r) => r.res),
      await save(w, doc.id, 1, fixturePdf(1), VERA).then((r) => r.res),
      await w.request("PATCH", `${A}/documents/${doc.id}`, { user: VERA, json: { name: "mine.pdf" } }),
      await w.request("DELETE", `${A}/documents/${doc.id}`, { user: VERA }),
      await w.request("POST", `${A}/folders`, { user: VERA, json: { name: "x" } }),
    ];
    expect(tries.map((r) => r.status)).toEqual([404, 404, 404, 404, 404]);
    expect(snapshot(w)).toBe(before);
  });

  it("no actor is 401; malformed ids are 404; unknown routes are 404 and wrong methods 405", async () => {
    const w = setup();
    expect((await w.request("GET", `${A}/folders`)).status).toBe(401);
    expect((await w.request("GET", `/v1/organizations/org_nothex/folders`, { user: ALICE })).status).toBe(404);
    expect((await w.request("GET", `${A}/documents/doc_123`, { user: ALICE })).status).toBe(404);
    expect((await w.request("GET", `${A}/documents/fld_${"a".repeat(32)}`, { user: ALICE })).status).toBe(404);
    expect((await w.request("GET", `${A}/nope`, { user: ALICE })).status).toBe(404);
    expect((await w.request("PUT", `${A}/folders`, { user: ALICE })).status).toBe(405);
    expect((await w.request("GET", `/health`)).status).toBe(200);
  });
});

describe("cross-org isolation", () => {
  it("every route given another org's folder, document, version or upload answers 404 and changes nothing", async () => {
    const w = setup();
    // Org A's world: a folder, a document with two versions and a thumbnail, a trashed folder and document, an open upload.
    const folder = (await json(await w.request("POST", `${A}/folders`, { user: ALICE, json: { name: "A folder" } }))).data.folder;
    const trashedFolder = (await json(await w.request("POST", `${A}/folders`, { user: ALICE, json: { name: "A trashed" } }))).data.folder;
    await w.request("DELETE", `${A}/folders/${trashedFolder.id}`, { user: ALICE });
    const doc = (await upload(w, "A doc.pdf", fixturePdf(2), folder.id)).body.data.document;
    await save(w, doc.id, 1, fixturePdf(3));
    await w.request("PUT", `${A}/documents/${doc.id}/versions/1/thumbnail`, { user: ALICE, body: WEBP, headers: { "content-type": "image/webp" } });
    const trashedDoc = (await upload(w, "A trashed.pdf")).body.data.document;
    await w.request("DELETE", `${A}/documents/${trashedDoc.id}`, { user: ALICE });
    const upl = (await json(await w.request("POST", `${A}/uploads`, { user: ALICE, json: { name: "A upload.pdf", size: 100 } }))).data.upload.id;
    // Bob owns org B and has his own things there.
    await upload(w, "B doc.pdf", fixturePdf(1), undefined, BOB, B);

    const before = snapshot(w);
    const pdf = fixturePdf(1, "intruder");
    const pdfHeaders = { "content-type": "application/pdf", "x-pagewell-base-version": "2" };
    // Bob, through his own org's routes, naming A's ids.
    const viaB: Array<[string, string, { body?: BodyInit; json?: unknown; headers?: Record<string, string> }?]> = [
      ["GET", `/folders/${folder.id}`],
      ["PATCH", `/folders/${folder.id}`, { json: { name: "mine" } }],
      ["DELETE", `/folders/${folder.id}`],
      ["POST", `/folders/${trashedFolder.id}/restore`],
      ["POST", `/folders`, { json: { name: "inside A", parentId: folder.id } }],
      ["POST", `/documents?name=x.pdf&folderId=${folder.id}`, { body: pdf, headers: { "content-type": "application/pdf" } }],
      ["GET", `/documents/${doc.id}`],
      ["PATCH", `/documents/${doc.id}`, { json: { name: "mine.pdf" } }],
      ["DELETE", `/documents/${doc.id}`],
      ["POST", `/documents/${trashedDoc.id}/restore`],
      ["GET", `/documents/${doc.id}/content`],
      ["GET", `/documents/${doc.id}/content?version=1`],
      ["HEAD", `/documents/${doc.id}/content`],
      ["GET", `/documents/${doc.id}/versions`],
      ["POST", `/documents/${doc.id}/versions`, { body: pdf, headers: pdfHeaders }],
      ["POST", `/documents/${doc.id}/versions/1/restore`],
      ["GET", `/documents/${doc.id}/versions/1/thumbnail`],
      ["PUT", `/documents/${doc.id}/versions/1/thumbnail`, { body: new Uint8Array([9]), headers: { "content-type": "image/webp" } }],
      ["PUT", `/documents/${doc.id}/versions/1/text`, { body: "{}", headers: { "content-type": "application/json" } }],
      ["POST", `/uploads`, { json: { name: "x.pdf", size: 10, docId: doc.id, baseVersion: 2 } }],
      ["PUT", `/uploads/${upl}/parts/1`, { body: pdf }],
      ["POST", `/uploads/${upl}/complete`, { json: { sha256: sha256(pdf) } }],
      ["DELETE", `/uploads/${upl}`],
    ];
    for (const [method, path, init] of viaB) {
      const res = await w.request(method, `${B}${path}`, { user: BOB, ...(init ?? {}) });
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 404 });
    }
    // Bob, through org A's routes directly: he is not a member, so A does not exist for him.
    for (const [method, path, init] of viaB) {
      const res = await w.request(method, `${A}${path}`, { user: BOB, ...(init ?? {}) });
      expect({ method, path: `A${path}`, status: res.status }).toEqual({ method, path: `A${path}`, status: 404 });
    }
    for (const path of ["/folders", "/documents", "/trash", "/quota"]) {
      expect((await w.request("GET", `${A}${path}`, { user: BOB })).status).toBe(404);
    }
    expect(snapshot(w)).toBe(before);

    // And Bob's own listings show only Bob's things.
    const recent = await json(await w.request("GET", `${B}/documents`, { user: BOB }));
    expect(recent.data.documents.map((d: { name: string }) => d.name)).toEqual(["B doc.pdf"]);
    expect((await json(await w.request("GET", `${B}/trash`, { user: BOB }))).data.entries).toEqual([]);
    expect([...w.bucket.objects.keys()].every((k) => k.startsWith(`org/${ORG_A}/`) || k.startsWith(`org/${ORG_B}/`))).toBe(true);
  });
});
