import type { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { createSqlExecutor } from "@saas/db/d1";
import { createReviewRepository, type ReviewRepository, type NewComment } from "@saas/db/review";
import { asUuid, manifest, type Uuid } from "@saas/db";
import { carryAnchor, versionText } from "@saas/shared/anchors";
import { d1Over, migratedDatabase, MIGRATIONS_ROOT } from "./sqlite-harness.js";

// Review (PW5) on a REAL SQLite engine: threads and comments, edits only by their author,
// statuses, carrying anchors once, review requests closing when everyone decided, reminders,
// and isolation. Plus the anchor rule: carried forward or outdated, never moved.

const ORG_A = asUuid("aaaaaaaa-0000-4000-8000-00000000000a");
const ORG_B = asUuid("bbbbbbbb-0000-4000-8000-00000000000b");
const DOC = asUuid("dddddddd-0000-4000-8000-00000000000d");
const ALICE = "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB = "usr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
let seq = 0;
const id = (): Uuid => asUuid(`00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`);
const T0 = new Date("2026-11-01T10:00:00.000Z");
const at = (m: number) => new Date(T0.getTime() + m * 60_000);
const anchor = { page: 2, rect: [10, 20, 100, 30] as [number, number, number, number], quote: "payment terms" };
const comment = (body: string, author = ALICE): NewComment => ({ id: id(), authorKind: "member", authorId: author, authorName: `${author}@example.com`, body, mentions: [] });

let db: DatabaseSync;
let repo: ReviewRepository;
beforeEach(() => {
  db = migratedDatabase();
  repo = createReviewRepository(createSqlExecutor(d1Over(db)));
});
afterEach(() => db.close());
const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

describe("migration 240_review_core", () => {
  it("is in the manifest under review, with the on-disk checksum", () => {
    const entry = manifest.migrations.find((m) => m.id === "240_review_core");
    expect(entry?.context).toBe("review");
    expect(entry?.checksum).toBe(createHash("sha256").update(readFileSync(resolve(MIGRATIONS_ROOT, "240_review_core/up.sql"), "utf8")).digest("hex"));
  });
});

describe("threads and comments", () => {
  it("a thread starts with its first comment; replies follow in order", async () => {
    const t = ok(await repo.createThread({ id: id(), orgId: ORG_A, docId: DOC, anchor, version: 3, comment: comment("Check this."), now: T0 }));
    expect(t).toMatchObject({ status: "open", version: 3, anchor, comments: [{ body: "Check this.", authorId: ALICE }] });
    ok(await repo.addComment(ORG_A, asUuid(t.id), comment("Agreed.", BOB), at(1)));
    const list = ok(await repo.listThreads(ORG_A, DOC));
    expect(list[0]!.comments.map((c) => c.body)).toEqual(["Check this.", "Agreed."]);
  });

  it("only the author edits a comment; a deleted one is blanked and stays in place", async () => {
    const t = ok(await repo.createThread({ id: id(), orgId: ORG_A, docId: DOC, anchor, version: 1, comment: comment("Typo hree."), now: T0 }));
    const c = t.comments[0]!;
    expect((await repo.editComment(ORG_A, asUuid(c.id), BOB, "hijack", [], at(1))).ok).toBe(false);
    expect(ok(await repo.editComment(ORG_A, asUuid(c.id), ALICE, "Typo here.", [], at(1)))).toMatchObject({ body: "Typo here.", editedAt: at(1) });
    expect((await repo.deleteComment(ORG_A, asUuid(c.id), BOB, at(2))).ok).toBe(false);
    expect(ok(await repo.deleteComment(ORG_A, asUuid(c.id), ALICE, at(2)))).toMatchObject({ body: "", deletedAt: at(2) });
    expect((await repo.editComment(ORG_A, asUuid(c.id), ALICE, "again", [], at(3))).ok).toBe(false);
    // An editor of the document may remove anyone's (author null).
    const other = ok(await repo.addComment(ORG_A, asUuid(t.id), comment("Spam", BOB), at(3)));
    expect(ok(await repo.deleteComment(ORG_A, asUuid(other.id), null, at(4))).deletedAt).toEqual(at(4));
  });

  it("resolves and reopens, but an outdated thread stays outdated", async () => {
    const t = ok(await repo.createThread({ id: id(), orgId: ORG_A, docId: DOC, anchor, version: 1, comment: comment("x"), now: T0 }));
    expect(ok(await repo.setStatus(ORG_A, asUuid(t.id), "resolved", BOB, at(1)))).toMatchObject({ status: "resolved", resolvedBy: BOB });
    expect(ok(await repo.setStatus(ORG_A, asUuid(t.id), "open", ALICE, at(2)))).toMatchObject({ status: "open", resolvedBy: null });
    ok(await repo.carry(ORG_A, asUuid(t.id), 1, 2, { status: "outdated", anchor }, at(3)));
    expect((await repo.setStatus(ORG_A, asUuid(t.id), "resolved", BOB, at(4))).ok).toBe(false);
  });

  it("carries a thread from its version once, even if two readers try", async () => {
    const t = ok(await repo.createThread({ id: id(), orgId: ORG_A, docId: DOC, anchor, version: 1, comment: comment("x"), now: T0 }));
    ok(await repo.carry(ORG_A, asUuid(t.id), 1, 3, { status: "open", anchor }, at(1)));
    const second = ok(await repo.carry(ORG_A, asUuid(t.id), 1, 4, { status: "outdated", anchor }, at(2)));
    expect(second).toMatchObject({ version: 3, status: "open" });
  });
});

describe("review requests", () => {
  it("close once every reviewer decided; only named reviewers may decide", async () => {
    const r = ok(await repo.createRequest({ id: id(), orgId: ORG_A, docId: DOC, version: 2, message: "Please review", dueAt: at(60 * 24), reviewers: ["Bob@Example.com", "carol@example.com", "bob@example.com"], createdBy: ALICE, now: T0 }));
    expect(r.reviewers.map((v) => v.email)).toEqual(["bob@example.com", "carol@example.com"]);
    expect((await repo.decide(ORG_A, asUuid(r.id), "mallory@example.com", "usr_m", "approved", at(1))).ok).toBe(false);
    expect(ok(await repo.decide(ORG_A, asUuid(r.id), "BOB@example.com", BOB, "approved", at(1))).status).toBe("open");
    const done = ok(await repo.decide(ORG_A, asUuid(r.id), "carol@example.com", "usr_c", "changes_requested", at(2)));
    expect(done).toMatchObject({ status: "closed", reviewers: [{ email: "bob@example.com", decision: "approved", userId: BOB }, { email: "carol@example.com", decision: "changes_requested" }] });
    expect((await repo.decide(ORG_A, asUuid(r.id), "bob@example.com", BOB, "changes_requested", at(3))).ok).toBe(false);
  });

  it("are found for reminders near their due date, once a day", async () => {
    const r = ok(await repo.createRequest({ id: id(), orgId: ORG_A, docId: DOC, version: 1, message: null, dueAt: at(60 * 20), reviewers: ["bob@example.com"], createdBy: ALICE, now: T0 }));
    ok(await repo.createRequest({ id: id(), orgId: ORG_A, docId: DOC, version: 1, message: null, dueAt: at(60 * 24 * 10), reviewers: ["bob@example.com"], createdBy: ALICE, now: T0 }));
    const day = 86_400_000;
    expect(ok(await repo.dueForReminder(T0, day, new Date(T0.getTime() - day), 10)).map((x) => x.id)).toEqual([r.id]);
    ok(await repo.markReminded(ORG_A, asUuid(r.id), T0));
    expect(ok(await repo.dueForReminder(at(60), day, new Date(at(60).getTime() - day), 10))).toEqual([]);
    expect(ok(await repo.dueForReminder(at(60 * 25), day, new Date(at(60 * 25).getTime() - day), 10)).map((x) => x.id)).toEqual([r.id]);
    ok(await repo.cancelRequest(ORG_A, asUuid(r.id)));
    expect(ok(await repo.dueForReminder(at(60 * 50), day, new Date(at(60 * 50).getTime() - day), 10))).toEqual([]);
  });
});

describe("isolation", () => {
  it("another org's ids find nothing and change nothing", async () => {
    const t = ok(await repo.createThread({ id: id(), orgId: ORG_A, docId: DOC, anchor, version: 1, comment: comment("x"), now: T0 }));
    const r = ok(await repo.createRequest({ id: id(), orgId: ORG_A, docId: DOC, version: 1, message: null, dueAt: null, reviewers: ["bob@example.com"], createdBy: ALICE, now: T0 }));
    const before = JSON.stringify(["review_threads", "review_comments", "review_requests", "review_request_reviewers"].map((x) => db.prepare(`SELECT * FROM ${x} ORDER BY 1`).all()));
    expect(ok(await repo.listThreads(ORG_B, DOC))).toEqual([]);
    expect((await repo.getThread(ORG_B, asUuid(t.id))).ok).toBe(false);
    expect((await repo.addComment(ORG_B, asUuid(t.id), comment("x"), at(1))).ok).toBe(false);
    expect((await repo.editComment(ORG_B, asUuid(t.comments[0]!.id), ALICE, "y", [], at(1))).ok).toBe(false);
    expect((await repo.deleteComment(ORG_B, asUuid(t.comments[0]!.id), null, at(1))).ok).toBe(false);
    expect((await repo.setStatus(ORG_B, asUuid(t.id), "resolved", BOB, at(1))).ok).toBe(false);
    expect((await repo.decide(ORG_B, asUuid(r.id), "bob@example.com", BOB, "approved", at(1))).ok).toBe(false);
    expect((await repo.cancelRequest(ORG_B, asUuid(r.id))).ok).toBe(false);
    expect(ok(await repo.listRequests(ORG_B, DOC))).toEqual([]);
    expect(JSON.stringify(["review_threads", "review_comments", "review_requests", "review_request_reviewers"].map((x) => db.prepare(`SELECT * FROM ${x} ORDER BY 1`).all()))).toBe(before);
  });
});

describe("carrying an anchor to a newer version", () => {
  const v = (pages: Record<number, string> | null, count: number | null) => versionText(pages ? { pages: Object.entries(pages).map(([p, text]) => ({ page: Number(p), text })) } : null, count);
  const old = v({ 1: "Cover page", 2: "The payment terms are thirty days." }, 2);

  it("keeps a quoted anchor whose quote is still on its page, even re-flowed", () => {
    expect(carryAnchor(anchor, old, v({ 1: "Cover", 2: "The payment\n  terms are sixty days." }, 2)).status).toBe("carried");
  });
  it("marks it outdated when the quote is gone, or only appears on another page (never moved)", () => {
    expect(carryAnchor(anchor, old, v({ 1: "Cover", 2: "Something else." }, 2))).toMatchObject({ status: "outdated", reason: "quote_gone" });
    expect(carryAnchor(anchor, old, v({ 1: "The payment terms are thirty days.", 2: "Other." }, 2))).toMatchObject({ status: "outdated", reason: "quote_gone" });
  });
  it("marks it outdated when its page is gone", () => {
    expect(carryAnchor(anchor, old, v({ 1: "Cover" }, 1))).toMatchObject({ status: "outdated", reason: "page_gone" });
  });
  it("keeps an unquoted anchor while its page's text is unchanged", () => {
    const pin = { ...anchor, quote: null };
    expect(carryAnchor(pin, old, v({ 1: "Changed cover", 2: "The payment terms are thirty days." }, 2)).status).toBe("carried");
    expect(carryAnchor(pin, old, v({ 1: "Cover page", 2: "Rewritten." }, 2))).toMatchObject({ status: "outdated", reason: "page_changed" });
  });
  it("without stored text, keeps an anchor whose page still exists", () => {
    expect(carryAnchor(anchor, v(null, 2), v(null, 3)).status).toBe("carried");
    expect(carryAnchor(anchor, v(null, 2), v(null, 1)).status).toBe("outdated");
  });
});
