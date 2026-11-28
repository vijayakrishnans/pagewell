import type { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { createSqlExecutor } from "@saas/db/d1";
import { createJobsRepository, type JobsRepository } from "@saas/db/jobs";
import { asUuid, manifest, type Uuid } from "@saas/db";
import { d1Over, migratedDatabase, MIGRATIONS_ROOT } from "./sqlite-harness.js";

// Heavy jobs (PW4) on a REAL SQLite engine: one runner takes a job, the states move one way,
// housekeeping finds stale and expired jobs, and another org's id finds and changes nothing.

const ORG_A = asUuid("aaaaaaaa-0000-4000-8000-00000000000a");
const ORG_B = asUuid("bbbbbbbb-0000-4000-8000-00000000000b");
const DOC = "dddddddd-0000-4000-8000-00000000000d";
let seq = 0;
const id = (): Uuid => asUuid(`00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`);
const T0 = new Date("2026-11-01T10:00:00.000Z");
const at = (m: number) => new Date(T0.getTime() + m * 60_000);

let db: DatabaseSync;
let repo: JobsRepository;
beforeEach(() => {
  db = migratedDatabase();
  repo = createJobsRepository(createSqlExecutor(d1Over(db)));
});
afterEach(() => db.close());

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};
const newJob = async (org = ORG_A, operation = "ocr") =>
  ok(await repo.create({ id: id(), orgId: org, operation, inputs: [{ docId: DOC, version: 2 }], options: { force: true }, outputMode: "version", createdBy: "usr_x", actorKind: "user", actorEmail: "x@example.com", now: T0 }));

describe("migration 220_jobs_core", () => {
  it("is in the manifest under jobs, with the on-disk checksum", () => {
    const entry = manifest.migrations.find((m) => m.id === "220_jobs_core");
    expect(entry?.context).toBe("jobs");
    expect(entry?.checksum).toBe(createHash("sha256").update(readFileSync(resolve(MIGRATIONS_ROOT, "220_jobs_core/up.sql"), "utf8")).digest("hex"));
  });
  it("refuses an unknown operation or status", () => {
    expect(() => db.prepare(`INSERT INTO jobs_jobs (id, org_id, operation, inputs_json, output_mode, created_by, actor_kind, created_at) VALUES ('x','o','format_disk','[]','version','u','user','t')`).run()).toThrow();
  });
});

describe("jobs", () => {
  it("move queued → running → succeeded once each; a second runner gets nothing", async () => {
    const j = await newJob();
    expect(j).toMatchObject({ status: "queued", attempts: 0, inputs: [{ docId: DOC, version: 2 }], actorEmail: "x@example.com" });
    const started = ok(await repo.start(ORG_A, asUuid(j.id), at(1)));
    expect(started).toMatchObject({ status: "running", attempts: 1 });
    expect((await repo.start(ORG_A, asUuid(j.id), at(1))).ok).toBe(false);
    const done = ok(await repo.succeed(ORG_A, asUuid(j.id), { documents: [{ docId: DOC, version: 3 }], files: [] }, 4, at(2), null));
    expect(done).toMatchObject({ status: "succeeded", pages: 4, result: { documents: [{ docId: DOC, version: 3 }] } });
    expect((await repo.fail(ORG_A, asUuid(j.id), "x", "y", at(3))).ok).toBe(false);
    expect((await repo.cancel(ORG_A, asUuid(j.id), at(3))).ok).toBe(false);
  });

  it("requeue lets a retry take it again; cancel works only before it starts", async () => {
    const j = await newJob();
    ok(await repo.start(ORG_A, asUuid(j.id), at(1)));
    ok(await repo.requeue(ORG_A, asUuid(j.id)));
    expect(ok(await repo.start(ORG_A, asUuid(j.id), at(2))).attempts).toBe(2);
    const k = await newJob();
    expect(ok(await repo.cancel(ORG_A, asUuid(k.id), at(1))).status).toBe("canceled");
    expect((await repo.start(ORG_A, asUuid(k.id), at(2))).ok).toBe(false);
  });

  it("counts active jobs, lists by document, and finds stale and expired ones", async () => {
    const a = await newJob();
    await newJob();
    expect(ok(await repo.activeCount(ORG_A))).toBe(2);
    ok(await repo.start(ORG_A, asUuid(a.id), at(1)));
    expect(ok(await repo.list(ORG_A, { docId: asUuid(DOC), limit: 10 }))).toHaveLength(2);
    expect(ok(await repo.list(ORG_A, { docId: asUuid("eeeeeeee-0000-4000-8000-00000000000e"), limit: 10 }))).toHaveLength(0);
    expect(ok(await repo.stale(at(30), 10)).map((j) => j.id)).toEqual([a.id]);
    ok(await repo.succeed(ORG_A, asUuid(a.id), { documents: [], files: [{ name: "page-1.png", type: "image/png", size: 1, r2Key: "k" }] }, 1, at(2), at(60)));
    expect(ok(await repo.expired(at(59), 10))).toHaveLength(0);
    expect(ok(await repo.expired(at(61), 10)).map((j) => j.id)).toEqual([a.id]);
    ok(await repo.clearFiles(ORG_A, asUuid(a.id)));
    expect(ok(await repo.get(ORG_A, asUuid(a.id))).result?.files).toEqual([]);
    expect(ok(await repo.expired(at(61), 10))).toHaveLength(0);
  });

  it("another org's id finds nothing and changes nothing", async () => {
    const j = await newJob();
    const before = JSON.stringify(db.prepare(`SELECT * FROM jobs_jobs`).all());
    expect((await repo.get(ORG_B, asUuid(j.id))).ok).toBe(false);
    expect((await repo.start(ORG_B, asUuid(j.id), at(1))).ok).toBe(false);
    expect((await repo.cancel(ORG_B, asUuid(j.id), at(1))).ok).toBe(false);
    expect((await repo.fail(ORG_B, asUuid(j.id), "x", "y", at(1))).ok).toBe(false);
    expect(ok(await repo.list(ORG_B, { limit: 10 }))).toEqual([]);
    expect(ok(await repo.activeCount(ORG_B))).toBe(0);
    expect(JSON.stringify(db.prepare(`SELECT * FROM jobs_jobs`).all())).toBe(before);
  });
});
