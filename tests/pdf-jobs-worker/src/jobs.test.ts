import { toPublic } from "@jobs-worker/ids";
import { RunnerError } from "@jobs-worker/runner";
import { sweep } from "@jobs-worker/cron";
import { route as jobsRoute } from "@jobs-worker/router";
import type { Uuid } from "@saas/db/ids";
import { fixturePdf, jobsWorld, type JobsWorld } from "./harness.js";

// Heavy jobs (PW4) through the jobs worker's router, run against the real files-worker: what a
// person may run is what the drive lets them do; results land as versions, documents or files;
// retries, limits, conflicts and cross-org isolation. Generated PDFs only.

const ORG_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const ORG_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const A = `/v1/organizations/${toPublic("org", ORG_A)}`;
const B = `/v1/organizations/${toPublic("org", ORG_B)}`;
const ALICE = "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; // owner of A
const VERA = "usr_cccccccccccccccccccccccccccccccc"; // viewer of A
const BOB = "usr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"; // owner of B
const GUEST = "usr_99999999999999999999999999999999";

type Json = { data: Record<string, any>; error?: { code: string; message: string } }; // eslint-disable-line @typescript-eslint/no-explicit-any
const json = async (res: Response) => (await res.json()) as Json;

function setup(limits: Record<string, number | null> = {}, opts: { runner?: boolean } = {}): JobsWorld {
  const w = jobsWorld(limits, opts);
  w.files.directory.add(ALICE, ORG_A, "owner");
  w.files.directory.add(VERA, ORG_A, "viewer");
  w.files.directory.add(BOB, ORG_B, "owner");
  return w;
}

async function upload(w: JobsWorld, name: string, folderId?: string, base = A, user = ALICE) {
  const q = new URLSearchParams({ name, ...(folderId ? { folderId } : {}) });
  const res = await w.files.request("POST", `${base}/documents?${q}`, { user, body: fixturePdf(3, name), headers: { "content-type": "application/pdf" } });
  expect(res.status).toBe(201);
  return (await json(res)).data.document as { id: string; currentVersion: number; folderId: string | null };
}
const create = (w: JobsWorld, body: Record<string, unknown>, user = ALICE, base = A, email?: string) => w.request("POST", `${base}/jobs`, { user, json: body, ...(email ? { email } : {}) });
const jobOf = async (w: JobsWorld, id: string, user = ALICE) => (await json(await w.request("GET", `${A}/jobs/${id}`, { user }))).data.job;

describe("running jobs", () => {
  it("rotate as a new version: queued, run once, the document's next version holds the result", async () => {
    const w = setup();
    const doc = await upload(w, "Rotate me.pdf");
    const res = await create(w, { operation: "rotate", documentIds: [doc.id], options: { degrees: 90 } });
    expect(res.status).toBe(202);
    const job = (await json(res)).data.job;
    expect(job).toMatchObject({ operation: "rotate", status: "queued", documentIds: [doc.id], version: 1, output: "version" });
    expect(await w.runQueued()).toEqual(["done"]);
    expect(w.runner.calls).toEqual([expect.objectContaining({ operation: "rotate", options: { degrees: 90 }, limits: expect.objectContaining({ pages: 200, cpuSeconds: 120 }) })]);
    const done = await jobOf(w, job.id);
    expect(done).toMatchObject({ status: "succeeded", result: { documents: [{ id: doc.id, version: 2 }], files: [] }, pages: 2 });
    const versions = (await json(await w.files.request("GET", `${A}/documents/${doc.id}/versions`, { user: ALICE }))).data.versions;
    expect(versions[0]).toMatchObject({ version: 2, createdBy: ALICE });
    // The same job is never run twice.
    expect(await w.run(ORG_A as Uuid, (job.id as string).replace("job_", "").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5") as Uuid)).toBe("skipped");
  });

  it("merge makes a new document beside the first; split makes one per part", async () => {
    const w = setup();
    const folder = (await json(await w.files.request("POST", `${A}/folders`, { user: ALICE, json: { name: "Work" } }))).data.folder;
    const one = await upload(w, "One.pdf", folder.id);
    const two = await upload(w, "Two.pdf");
    const m = (await json(await create(w, { operation: "merge", documentIds: [one.id, two.id] }))).data.job;
    expect(m.output).toBe("document");
    const s = (await json(await create(w, { operation: "split", documentIds: [two.id], options: { every: 1 } }))).data.job;
    await w.runQueued();
    const merged = await jobOf(w, m.id);
    expect(merged.status).toBe("succeeded");
    const listing = (await json(await w.files.request("GET", `${A}/folders/${folder.id}`, { user: ALICE }))).data.documents.map((d: { name: string }) => d.name);
    expect(listing).toContain("One (merged).pdf");
    const split = await jobOf(w, s.id);
    expect(split.result.documents).toHaveLength(2);
    const root = (await json(await w.files.request("GET", `${A}/folders`, { user: ALICE }))).data.documents.map((d: { name: string }) => d.name);
    expect(root).toEqual(expect.arrayContaining(["Two (part 1 of 2).pdf", "Two (part 2 of 2).pdf"]));
  });

  it("render keeps its files for a day, served to whoever may read the document, then removed", async () => {
    const w = setup();
    const doc = await upload(w, "Render me.pdf");
    const job = (await json(await create(w, { operation: "render", documentIds: [doc.id], options: { pages: [1, 2], dpi: 72 } }))).data.job;
    expect(job.output).toBe("files");
    await w.runQueued();
    const done = await jobOf(w, job.id);
    expect(done.result.files.map((f: { name: string }) => f.name)).toEqual(["page-1.png", "page-2.png"]);
    const file = await w.request("GET", `${A}/jobs/${job.id}/files/page-1.png`, { user: VERA });
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/png");
    expect([...w.files.bucket.objects.keys()].filter((k) => k.includes("/jobs/"))).toHaveLength(2);
    expect((await w.request("GET", `${A}/jobs/${job.id}/files/../../x`, { user: ALICE })).status).toBe(404);
    expect((await w.request("GET", `${A}/jobs/${job.id}/files/page-9.png`, { user: ALICE })).status).toBe(404);

    const later = new Date(w.files.now.getTime() + 25 * 3_600_000);
    expect(await sweep(w.env, later)).toEqual({ lost: 0, filesRemoved: 2 });
    expect([...w.files.bucket.objects.keys()].filter((k) => k.includes("/jobs/"))).toHaveLength(0);
    expect((await w.request("GET", `${A}/jobs/${job.id}/files/page-1.png`, { user: ALICE })).status).toBe(404);
  });

  it("a document's activity shows the job starting and finishing, and the version it saved", async () => {
    const w = setup();
    const doc = await upload(w, "Tracked.pdf");
    w.files.now = new Date(w.files.now.getTime() + 1000);
    await create(w, { operation: "compress", documentIds: [doc.id] });
    w.files.now = new Date(w.files.now.getTime() + 1000);
    await w.runQueued();
    const types = (await json(await w.files.request("GET", `${A}/documents/${doc.id}/activity`, { user: ALICE }))).data.entries.map((e: { type: string }) => e.type);
    // The save and the job's end are written by two workers in one step (the same instant here).
    expect(types.slice(0, 2).sort()).toEqual(["job.succeeded", "version.created"]);
    expect(types.slice(2)).toEqual(["job.created", "document.created"]);
  });
});

describe("who may run what", () => {
  it("a viewer may render and extract text, not make a new version; a member with no read gets 404", async () => {
    const w = setup();
    const doc = await upload(w, "Shared.pdf");
    expect((await create(w, { operation: "render", documentIds: [doc.id] }, VERA)).status).toBe(202);
    expect((await create(w, { operation: "text", documentIds: [doc.id] }, VERA)).status).toBe(202);
    expect((await create(w, { operation: "compress", documentIds: [doc.id] }, VERA)).status).toBe(404);
    expect((await create(w, { operation: "rotate", documentIds: [doc.id], options: { degrees: 90 } }, BOB)).status).toBe(404);
    expect((await create(w, { operation: "render", documentIds: [doc.id] }, GUEST, A, "guest@example.com")).status).toBe(404);
  });

  it("a guest works on what was shared with them, as the email it was shared to", async () => {
    const w = setup();
    const doc = await upload(w, "For a guest.pdf");
    await w.files.request("POST", `${A}/documents/${doc.id}/grants`, { user: ALICE, json: { email: "guest@example.com", role: "editor", notify: false } });
    const res = await create(w, { operation: "flatten", documentIds: [doc.id] }, GUEST, A, "guest@example.com");
    expect(res.status).toBe(202);
    await w.runQueued();
    const job = (await json(res)).data.job;
    expect((await jobOf(w, job.id, GUEST)).status).toBe("succeeded");
    // The share is removed before a second job runs: that job fails, and saves nothing.
    const second = (await json(await create(w, { operation: "sanitize", documentIds: [doc.id] }, GUEST, A, "guest@example.com"))).data.job;
    const guests = (await json(await w.files.request("GET", `${A}/guests`, { user: ALICE }))).data.guests;
    await w.files.request("DELETE", `${A}/guests/${guests[0].id}`, { user: ALICE });
    await w.runQueued();
    const failed = await jobOf(w, second.id, ALICE);
    expect(failed).toMatchObject({ status: "failed", error: { code: "not_found" } });
    const versions = (await json(await w.files.request("GET", `${A}/documents/${doc.id}/versions`, { user: ALICE }))).data.versions;
    expect(versions).toHaveLength(2);
  });

  it("a job is seen by its creator and by readers of its document; only its creator cancels it", async () => {
    const w = setup();
    const doc = await upload(w, "Seen.pdf");
    const job = (await json(await create(w, { operation: "rotate", documentIds: [doc.id], options: { degrees: 180 } }))).data.job;
    expect((await w.request("GET", `${A}/jobs/${job.id}`, { user: VERA })).status).toBe(200);
    expect((await w.request("GET", `${A}/jobs/${job.id}`, { user: BOB })).status).toBe(404);
    expect((await w.request("POST", `${A}/jobs/${job.id}/cancel`, { user: VERA })).status).toBe(404);
    const canceled = await w.request("POST", `${A}/jobs/${job.id}/cancel`, { user: ALICE });
    expect((await json(canceled)).data.job.status).toBe("canceled");
    expect(await w.runQueued()).toEqual(["skipped"]);
    expect((await w.request("POST", `${A}/jobs/${job.id}/cancel`, { user: ALICE })).status).toBe(409);
    const mine = (await json(await w.request("GET", `${A}/jobs`, { user: ALICE }))).data.jobs;
    expect(mine.map((j: { id: string }) => j.id)).toEqual([job.id]);
    expect((await json(await w.request("GET", `${A}/jobs`, { user: VERA }))).data.jobs).toEqual([]);
    expect((await json(await w.request("GET", `${A}/jobs?documentId=${doc.id}`, { user: VERA }))).data.jobs).toHaveLength(1);
    expect((await w.request("GET", `${A}/jobs?documentId=${doc.id}`, { user: BOB })).status).toBe(404);
  });
});

describe("limits, failures and retries", () => {
  it("the plan's concurrency limit refuses another job while two are queued or running", async () => {
    const w = setup();
    const doc = await upload(w, "Busy.pdf");
    expect((await create(w, { operation: "render", documentIds: [doc.id] })).status).toBe(202);
    expect((await create(w, { operation: "render", documentIds: [doc.id] })).status).toBe(202);
    const third = await create(w, { operation: "render", documentIds: [doc.id] });
    expect(third.status).toBe(429);
    expect((await json(third)).error?.code).toBe("jobs_busy");
    await w.runQueued();
    expect((await create(w, { operation: "render", documentIds: [doc.id] })).status).toBe(202);
  });

  it("the plan's page and CPU limits go to the runner; a plan sets them higher", async () => {
    const w = setup({ "jobs.pages_per_job": 1000, "jobs.cpu_seconds_per_job": 240, "jobs.concurrent": 5 });
    const doc = await upload(w, "Big plan.pdf");
    await create(w, { operation: "ocr", documentIds: [doc.id], options: { force: true } });
    await w.runQueued();
    expect(w.runner.calls[0]!.limits).toMatchObject({ pages: 1000, cpuSeconds: 240, wallSeconds: 480 });
  });

  it("a runner that cannot be reached is retried; a refusal ends the job with its code", async () => {
    const w = setup();
    const doc = await upload(w, "Flaky.pdf");
    const job = (await json(await create(w, { operation: "compress", documentIds: [doc.id] }))).data.job;
    w.runner.failures.push(new RunnerError(503, "runner_unavailable", "down", true));
    const { orgId, jobId } = w.queued.splice(0)[0]!;
    expect(await w.run(orgId, jobId)).toBe("retry");
    expect((await jobOf(w, job.id)).status).toBe("queued");
    expect(await w.run(orgId, jobId)).toBe("done");
    expect((await jobOf(w, job.id)).status).toBe("succeeded");

    const big = (await json(await create(w, { operation: "ocr", documentIds: [doc.id] }))).data.job;
    w.runner.failures.push(new RunnerError(422, "limit_exceeded", "3 pages is over this job's limit of 2", false));
    await w.runQueued();
    expect(await jobOf(w, big.id)).toMatchObject({ status: "failed", error: { code: "limit_exceeded", message: "3 pages is over this job's limit of 2" } });
  });

  it("a save made while the job ran wins: the job fails with version_conflict and saves nothing", async () => {
    const w = setup();
    const doc = await upload(w, "Contended.pdf");
    const job = (await json(await create(w, { operation: "flatten", documentIds: [doc.id] }))).data.job;
    await w.files.request("POST", `${A}/documents/${doc.id}/versions`, { user: ALICE, body: fixturePdf(1, "someone"), headers: { "content-type": "application/pdf", "x-pagewell-base-version": "1" } });
    await w.runQueued();
    expect(await jobOf(w, job.id)).toMatchObject({ status: "failed", error: { code: "version_conflict" } });
    const versions = (await json(await w.files.request("GET", `${A}/documents/${doc.id}/versions`, { user: ALICE }))).data.versions;
    expect(versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
  });

  it("without a runner, jobs are refused up front", async () => {
    const w = setup({}, { runner: false });
    const doc = await upload(w, "Nowhere.pdf");
    const res = await create(w, { operation: "render", documentIds: [doc.id] });
    expect(res.status).toBe(503);
    expect((await json(res)).error?.code).toBe("runner_unavailable");
  });

  it("a job whose runner died is failed by the sweep", async () => {
    const w = setup();
    const doc = await upload(w, "Lost.pdf");
    const job = (await json(await create(w, { operation: "render", documentIds: [doc.id] }))).data.job;
    w.files.db.prepare(`UPDATE jobs_jobs SET status = 'running', started_at = ?`).run(new Date(w.files.now.getTime() - 3_600_000).toISOString());
    expect(await sweep(w.env, w.files.now)).toEqual({ lost: 1, filesRemoved: 0 });
    expect((await jobOf(w, job.id)).error.code).toBe("runner_lost");
  });

  it("validates what it is asked", async () => {
    const w = setup();
    const doc = await upload(w, "Valid.pdf");
    const bad = [
      { operation: "delete", documentIds: [doc.id] },
      { operation: "merge", documentIds: [doc.id] },
      { operation: "merge", documentIds: [doc.id, doc.id] },
      { operation: "rotate", documentIds: ["nope"] },
      { operation: "render", documentIds: [doc.id], version: 9 },
      { operation: "render", documentIds: [doc.id], output: "version" },
      { operation: "render", documentIds: [doc.id], options: { blob: "x".repeat(5000) } },
      { operation: "render", documentIds: [doc.id], options: [] },
    ];
    for (const body of bad) expect({ body, status: (await create(w, body)).status }).toEqual({ body, status: 422 });
    expect((await w.request("POST", `${A}/jobs`, { json: { operation: "render", documentIds: [doc.id] } })).status).toBe(401);
    expect((await w.request("PUT", `${A}/jobs`, { user: ALICE })).status).toBe(405);
  });
});

describe("isolation", () => {
  it("another org's documents and jobs answer 404 and nothing runs", async () => {
    const w = setup();
    const docA = await upload(w, "A's.pdf");
    const docB = await upload(w, "B's.pdf", undefined, B, BOB);
    const jobA = (await json(await create(w, { operation: "render", documentIds: [docA.id] }))).data.job;
    expect((await create(w, { operation: "render", documentIds: [docA.id] }, BOB, B)).status).toBe(404);
    expect((await create(w, { operation: "merge", documentIds: [docB.id, docA.id] }, BOB, B)).status).toBe(404);
    expect((await w.request("GET", `${B}/jobs/${jobA.id}`, { user: BOB })).status).toBe(404);
    expect((await w.request("GET", `${A}/jobs/${jobA.id}`, { user: BOB })).status).toBe(404);
    expect((await w.request("POST", `${B}/jobs/${jobA.id}/cancel`, { user: BOB })).status).toBe(404);
    expect((await w.request("GET", `${B}/jobs/${jobA.id}/files/page-1.png`, { user: BOB })).status).toBe(404);
    expect(w.queued).toHaveLength(1);
  });
});

describe("the e-sign completion route (PW6)", () => {
  const run = (w: JobsWorld, operation: string) =>
    jobsRoute(new Request("http://jobs/internal/sign-complete", { method: "POST", headers: { "x-pagewell-run": JSON.stringify({ operation, options: {}, inputs: [3] }) }, body: "abc" }), w.env, w.files.now);

  it("passes only sign_complete to the runner, as it came, and its answer back", async () => {
    expect((await run(jobsWorld({}, { runner: false }), "sign_complete")).status).toBe(503);
    const w = jobsWorld();
    expect((await run(w, "rotate")).status).toBe(400);
    const seen: Array<{ url: string; header: string | null; body: string }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const req = input as Request;
      seen.push({ url: req.url, header: req.headers.get("x-pagewell-run"), body: await req.text() });
      return new Response("PDFJSON", { headers: { "x-pagewell-outputs": '[{"name":"result.pdf","size":3},{"name":"signature.json","size":4}]', "x-pagewell-pages": "3" } });
    }) as typeof fetch;
    try {
      const res = await run(w, "sign_complete");
      expect(res.status).toBe(200);
      expect(res.headers.get("x-pagewell-outputs")).toContain("result.pdf");
      expect(await res.text()).toBe("PDFJSON");
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(seen).toEqual([{ url: "http://runner.test/run", header: JSON.stringify({ operation: "sign_complete", options: {}, inputs: [3] }), body: "abc" }]);
  });
});
