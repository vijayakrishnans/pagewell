import type { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { createSqlExecutor } from "@saas/db/d1";
import { createSignRepository, currentWave, type DraftInput, type SignRepository, type StoredEvent } from "@saas/db/sign";
import { asUuid, manifest, type Uuid } from "@saas/db";
import { canonical, GENESIS, nextEvent, verifyChain, type EvidenceEvent, type Json } from "@saas/shared/evidence";
import { d1Over, migratedDatabase, MIGRATIONS_ROOT } from "./sqlite-harness.js";

// E-sign (PW6) on a REAL SQLite engine: drafts, sending (versions frozen), links, email codes
// with a try limit, signing in parallel and in order, declining, voiding, expiry, reminders,
// completion, the append-only evidence log, isolation. Plus the evidence chain itself.

const ORG_A = asUuid("aaaaaaaa-0000-4000-8000-00000000000a");
const ORG_B = asUuid("bbbbbbbb-0000-4000-8000-00000000000b");
const DOC = asUuid("dddddddd-0000-4000-8000-00000000000d");
const ALICE = "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
let seq = 0;
const id = (): Uuid => asUuid(`00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`);
const T0 = new Date("2026-11-01T10:00:00.000Z");
const at = (m: number) => new Date(T0.getTime() + m * 60_000);
const DAY = 24 * 60;
const meta = { ip: "203.0.113.7", userAgent: "test" };

let db: DatabaseSync;
let repo: SignRepository;
beforeEach(() => {
  db = migratedDatabase();
  repo = createSignRepository(createSqlExecutor(d1Over(db)));
});
afterEach(() => db.close());
const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

function draft(orderMode: "parallel" | "sequential" = "parallel", reminderDays: number | null = null): DraftInput & { ids: { s1: Uuid; s2: Uuid; f1: Uuid; f2: Uuid; f3: Uuid } } {
  const s1 = id();
  const s2 = id();
  const f1 = id();
  const f2 = id();
  const f3 = id();
  return {
    ids: { s1, s2, f1, f2, f3 },
    title: "Generated agreement",
    message: "Please sign",
    orderMode,
    expiresAt: at(30 * DAY),
    reminderDays,
    documents: [{ docId: DOC, name: "Generated.pdf" }],
    signers: [
      { id: s1, name: "Ann", email: "Ann@Example.com", order: 1 },
      { id: s2, name: "Ben", email: "ben@example.com", order: 2 },
    ],
    fields: [
      { id: f1, signerId: s1, docId: DOC, page: 1, rect: [72, 600, 200, 40], kind: "signature", required: true, label: null },
      { id: f2, signerId: s1, docId: DOC, page: 1, rect: [300, 600, 100, 20], kind: "date", required: false, label: "Date" },
      { id: f3, signerId: s2, docId: DOC, page: 2, rect: [72, 600, 200, 40], kind: "signature", required: true, label: null },
    ],
  };
}

async function sent(orderMode: "parallel" | "sequential" = "parallel", reminderDays: number | null = null) {
  const d = draft(orderMode, reminderDays);
  const env = ok(await repo.createDraft({ ...d, id: id(), orgId: ORG_A, createdBy: ALICE, now: T0 }));
  ok(await repo.send(ORG_A, asUuid(env.id), [{ docId: DOC, version: 3, sha256: "a".repeat(64), pageCount: 2 }], at(1)));
  return { env, ...d.ids };
}
const verify = async (signer: Uuid, token = `t-${signer}`) => {
  ok(await repo.issueToken(ORG_A, signer, token, at(14 * DAY), at(2)));
  ok(await repo.setOtp(ORG_A, signer, `otp-${signer}`, at(12)));
  expect(ok(await repo.checkOtp(ORG_A, signer, `otp-${signer}`, at(3))).matched).toBe(true);
};

describe("migration 250_sign_core", () => {
  it("is in the manifest under sign, with the on-disk checksum", () => {
    const entry = manifest.migrations.find((m) => m.id === "250_sign_core");
    expect(entry?.context).toBe("sign");
    expect(entry?.checksum).toBe(createHash("sha256").update(readFileSync(resolve(MIGRATIONS_ROOT, "250_sign_core/up.sql"), "utf8")).digest("hex"));
  });
});

describe("drafts and sending", () => {
  it("a draft holds documents, signers (emails lower-cased) and fields; it changes only while a draft; sending freezes versions", async () => {
    const d = draft();
    const env = ok(await repo.createDraft({ ...d, id: id(), orgId: ORG_A, createdBy: ALICE, senderEmail: "alice@example.com", now: T0 }));
    expect(env).toMatchObject({ status: "draft", senderEmail: "alice@example.com", orderMode: "parallel", documents: [{ docId: DOC, version: null }], signers: [{ name: "Ann", email: "ann@example.com", status: "pending" }, { name: "Ben" }] });
    expect(env.fields.map((f) => f.kind)).toEqual(["signature", "date", "signature"]);

    const changed = ok(await repo.updateDraft(ORG_A, asUuid(env.id), { ...draft(), title: "Renamed" }, at(1)));
    expect(changed.title).toBe("Renamed");
    expect(changed.signers).toHaveLength(2);
    expect(changed.fields).toHaveLength(3);

    const s = ok(await repo.send(ORG_A, asUuid(env.id), [{ docId: DOC, version: 3, sha256: "a".repeat(64), pageCount: 2 }], at(2)));
    expect(s).toMatchObject({ status: "sent", documents: [{ version: 3, sha256: "a".repeat(64), pageCount: 2 }] });
    expect(await repo.send(ORG_A, asUuid(env.id), [], at(3))).toMatchObject({ ok: false, error: { kind: "conflict" } });
    expect(await repo.updateDraft(ORG_A, asUuid(env.id), draft(), at(3))).toMatchObject({ ok: false, error: { kind: "conflict" } });
    expect(ok(await repo.listEnvelopes(ORG_A, { limit: 10 })).map((e) => e.id)).toEqual([env.id]);
    expect(ok(await repo.listEnvelopes(ORG_A, { limit: 10, status: "draft" }))).toEqual([]);
  });
});

describe("links and email codes", () => {
  it("a link finds its signer only while live; a code verifies once; five wrong tries end it", async () => {
    const { s1 } = await sent();
    ok(await repo.issueToken(ORG_A, s1, "tok-1", at(14 * DAY), at(2)));
    expect(ok(await repo.signerByToken("tok-1", at(3))).signer.id).toBe(s1);
    expect(await repo.signerByToken("tok-1", at(15 * DAY))).toMatchObject({ ok: false, error: { kind: "not_found" } });
    expect(await repo.signerByToken("nope", at(3))).toMatchObject({ ok: false });
    // A resend replaces the token.
    ok(await repo.issueToken(ORG_A, s1, "tok-2", at(14 * DAY), at(4)));
    expect(await repo.signerByToken("tok-1", at(5))).toMatchObject({ ok: false });

    ok(await repo.setOtp(ORG_A, s1, "good", at(15)));
    for (let i = 0; i < 4; i++) expect(ok(await repo.checkOtp(ORG_A, s1, "bad", at(6))).matched).toBe(false);
    expect(ok(await repo.checkOtp(ORG_A, s1, "good", at(6))).matched).toBe(true);
    ok(await repo.setOtp(ORG_A, s1, "good2", at(25)));
    for (let i = 0; i < 5; i++) ok(await repo.checkOtp(ORG_A, s1, "bad", at(7)));
    expect(ok(await repo.checkOtp(ORG_A, s1, "good2", at(7))).matched).toBe(false); // spent after five wrong tries
    // An expired code does not verify.
    ok(await repo.setOtp(ORG_A, s1, "late", at(8)));
    expect(ok(await repo.checkOtp(ORG_A, s1, "late", at(9))).matched).toBe(false);
  });
});

describe("signing", () => {
  it("parallel: each verified signer signs their own fields; the link is spent; then the envelope completes", async () => {
    const { env, s1, s2, f1, f2, f3 } = await sent();
    const E = asUuid(env.id);
    ok(await repo.issueToken(ORG_A, s1, "t1", at(14 * DAY), at(2)));
    // Not verified yet.
    expect(await repo.submit(ORG_A, s1, [{ fieldId: f1, value: { text: "Ann" } }], meta, at(3))).toMatchObject({ ok: false, error: { kind: "conflict" } });
    await verify(s1, "t1b");
    // A required field missing; a field that is someone else's.
    expect(await repo.submit(ORG_A, s1, [{ fieldId: f2, value: { text: "2026-11-01" } }], meta, at(4))).toMatchObject({ ok: false });
    expect(await repo.submit(ORG_A, s1, [{ fieldId: f1, value: { text: "Ann" } }, { fieldId: f3, value: { text: "x" } }], meta, at(4))).toMatchObject({ ok: false });
    expect(await repo.markCompleting(ORG_A, E, null, at(4))).toMatchObject({ ok: false, error: { kind: "conflict" } });
    const after1 = ok(await repo.submit(ORG_A, s1, [{ fieldId: f1, value: { text: "Ann" } }], meta, at(5)));
    expect(after1.signers.find((s) => s.id === s1)).toMatchObject({ status: "signed", ip: "203.0.113.7", tokenExpiresAt: null });
    expect(after1.fields.find((f) => f.id === f1)?.value).toEqual({ text: "Ann" });
    expect(await repo.signerByToken("t1b", at(6))).toMatchObject({ ok: false });
    expect(await repo.submit(ORG_A, s1, [{ fieldId: f1, value: { text: "Again" } }], meta, at(6))).toMatchObject({ ok: false });

    await verify(s2);
    ok(await repo.submit(ORG_A, s2, [{ fieldId: f3, value: { imageKey: "org/x/sign/y/sig.png" } }], meta, at(7)));
    const completing = ok(await repo.markCompleting(ORG_A, E, "job-1", at(8)));
    expect(completing).toMatchObject({ status: "completing", completionJobId: "job-1" });
    expect(ok(await repo.stuckCompleting(at(60), 10)).map((e) => e.id)).toEqual([env.id]);
    const done = ok(await repo.complete(ORG_A, E, asUuid("eeeeeeee-0000-4000-8000-00000000000e"), 1, at(9)));
    expect(done).toMatchObject({ status: "completed", completedVersion: 1 });
    expect(await repo.complete(ORG_A, E, DOC, 2, at(10))).toMatchObject({ ok: false, error: { kind: "conflict" } });
  });

  it("sequential: the second signer cannot sign before the first", async () => {
    const { env, s1, s2, f1, f3 } = await sent("sequential");
    expect(currentWave(env.signers)).toBe(1);
    await verify(s2);
    expect(await repo.submit(ORG_A, s2, [{ fieldId: f3, value: { text: "Ben" } }], meta, at(4))).toMatchObject({ ok: false, error: { kind: "conflict", message: expect.stringContaining("turn") } });
    await verify(s1);
    ok(await repo.submit(ORG_A, s1, [{ fieldId: f1, value: { text: "Ann" } }], meta, at(5)));
    const after = ok(await repo.submit(ORG_A, s2, [{ fieldId: f3, value: { text: "Ben" } }], meta, at(6)));
    expect(currentWave(after.signers)).toBeNull();
  });

  it("a decline ends the envelope and every link; a void does too; expiry does too", async () => {
    const a = await sent();
    ok(await repo.issueToken(ORG_A, a.s1, "d1", at(14 * DAY), at(2)));
    ok(await repo.issueToken(ORG_A, a.s2, "d2", at(14 * DAY), at(2)));
    const declined = ok(await repo.decline(ORG_A, a.s1, "Wrong amount", meta, at(3)));
    expect(declined).toMatchObject({ status: "declined" });
    expect(declined.signers.find((s) => s.id === a.s1)).toMatchObject({ status: "declined", declineReason: "Wrong amount" });
    expect(await repo.signerByToken("d2", at(4))).toMatchObject({ ok: false });

    const b = await sent();
    ok(await repo.issueToken(ORG_A, b.s1, "v1", at(14 * DAY), at(2)));
    expect(ok(await repo.void(ORG_A, asUuid(b.env.id), "Sent by mistake", at(3)))).toMatchObject({ status: "voided", voidReason: "Sent by mistake" });
    expect(await repo.signerByToken("v1", at(4))).toMatchObject({ ok: false });
    expect(await repo.void(ORG_A, asUuid(b.env.id), null, at(5))).toMatchObject({ ok: false, error: { kind: "conflict" } });

    const c = await sent();
    ok(await repo.issueToken(ORG_A, c.s1, "x1", at(60 * DAY), at(2)));
    expect(ok(await repo.expireDue(at(31 * DAY), 10))).toEqual([{ orgId: ORG_A, envelopeId: c.env.id }]);
    expect(await repo.signerByToken("x1", at(31 * DAY))).toMatchObject({ ok: false });
  });

  it("reminders: due every reminder_days since the last notice, only to signers with a live link", async () => {
    const { s1, s2 } = await sent("parallel", 2);
    ok(await repo.issueToken(ORG_A, s1, "r1", at(14 * DAY), at(2)));
    expect(ok(await repo.dueForReminder(at(DAY), 10))).toEqual([]);
    const due = ok(await repo.dueForReminder(at(2 * DAY + 5), 10));
    expect(due.map((d) => d.signer.id)).toEqual([s1]); // s2 has no link yet
    ok(await repo.markReminded(ORG_A, s1, at(2 * DAY + 5)));
    expect(ok(await repo.dueForReminder(at(3 * DAY), 10))).toEqual([]);
    expect(ok(await repo.dueForReminder(at(4 * DAY + 10), 10)).map((d) => d.signer.id)).toEqual([s1]);
    void s2;
  });
});

describe("the evidence log", () => {
  it("chains events, refuses a second writer of a place, and cannot be changed or deleted", async () => {
    const { env } = await sent();
    const E = asUuid(env.id);
    let last: StoredEvent | null = null;
    for (const [kind, payload] of [["envelope.sent", { documents: [{ sha256: "a".repeat(64) }] }], ["signer.viewed", { signer: "Ann" }], ["signer.signed", { signer: "Ann", ip: "203.0.113.7" }]] as Array<[string, Json]>) {
      const e = await nextEvent(last, kind, at(seq).toISOString(), payload);
      ok(await repo.appendEvent(ORG_A, E, e));
      last = e;
    }
    const events = ok(await repo.listEvents(ORG_A, E));
    expect(events.map((e) => e.kind)).toEqual(["envelope.sent", "signer.viewed", "signer.signed"]);
    expect(events[0]!.prevHash).toBe(GENESIS);
    expect(await verifyChain(events as EvidenceEvent[])).toEqual({ ok: true, head: last!.hash, length: 3 });
    expect(ok(await repo.lastEvent(ORG_A, E))?.seq).toBe(3);

    // A second writer of seq 3 is refused.
    const clash = await nextEvent({ seq: 2, hash: events[1]!.hash }, "signer.viewed", at(99).toISOString(), {});
    expect(await repo.appendEvent(ORG_A, E, clash)).toMatchObject({ ok: false, error: { kind: "conflict" } });
    // The table refuses changes.
    expect(() => db.prepare(`UPDATE sign_events SET payload_json = '{}' WHERE seq = 2`).run()).toThrow(/append-only/);
    expect(() => db.prepare(`DELETE FROM sign_events WHERE seq = 3`).run()).toThrow(/append-only/);
    // Another org cannot write into this envelope's log.
    expect(await repo.appendEvent(ORG_B, E, await nextEvent(last, "x", at(1).toISOString(), {}))).toMatchObject({ ok: false, error: { kind: "not_found" } });
  });

  it("verifyChain finds a changed payload, a broken link and a gap", async () => {
    let last: EvidenceEvent | null = null;
    const chain: EvidenceEvent[] = [];
    for (let i = 0; i < 4; i++) {
      last = await nextEvent(last, `k${i}`, at(i).toISOString(), { n: i, nested: { b: 2, a: 1 } });
      chain.push(last);
    }
    expect((await verifyChain(chain)).ok).toBe(true);
    expect(await verifyChain(chain.map((e, i) => (i === 1 ? { ...e, payload: { n: 99 } } : e)))).toEqual({ ok: false, brokenAt: 2, reason: "hash" });
    expect(await verifyChain(chain.map((e, i) => (i === 2 ? { ...e, prevHash: "f".repeat(64) } : e)))).toEqual({ ok: false, brokenAt: 3, reason: "link" });
    expect(await verifyChain([chain[0]!, chain[2]!])).toEqual({ ok: false, brokenAt: 2, reason: "sequence" });
    expect(canonical({ b: [1, { d: 1, c: 2 }], a: "x", u: undefined })).toBe('{"a":"x","b":[1,{"c":2,"d":1}]}');
  });
});

describe("isolation", () => {
  it("another org sees and changes nothing", async () => {
    const { env, s1, f1 } = await sent();
    const E = asUuid(env.id);
    expect(await repo.getEnvelope(ORG_B, E)).toMatchObject({ ok: false, error: { kind: "not_found" } });
    expect(ok(await repo.listEnvelopes(ORG_B, { limit: 10 }))).toEqual([]);
    expect(await repo.issueToken(ORG_B, s1, "evil", at(14 * DAY), at(2))).toMatchObject({ ok: false });
    expect(await repo.void(ORG_B, E, null, at(2))).toMatchObject({ ok: false, error: { kind: "not_found" } });
    expect(await repo.submit(ORG_B, s1, [{ fieldId: f1, value: { text: "x" } }], meta, at(2))).toMatchObject({ ok: false, error: { kind: "not_found" } });
    expect(await repo.updateDraft(ORG_B, E, draft(), at(2))).toMatchObject({ ok: false, error: { kind: "not_found" } });
    expect(ok(await repo.getEnvelope(ORG_A, E)).status).toBe("sent");
  });
});

describe("the migration splitter and triggers", () => {
  it("keeps a CREATE TRIGGER body whole and splits after its END", async () => {
    const { D1ApiAdapter } = await import("@saas/db/runner");
    const parts = D1ApiAdapter.splitStatements(`CREATE TABLE t (a INT);
-- a comment; with a semicolon
CREATE TRIGGER IF NOT EXISTS t_no_update BEFORE UPDATE ON t
BEGIN
  SELECT RAISE(ABORT, 'no; really');
  SELECT 1;
END;
CREATE INDEX i ON t (a);`);
    expect(parts).toHaveLength(3);
    expect(parts[1]).toMatch(/^-- a comment; with a semicolon\nCREATE TRIGGER[\s\S]*SELECT 1;\nEND$/);
    expect(parts[2]).toBe("CREATE INDEX i ON t (a)");
  });
});
