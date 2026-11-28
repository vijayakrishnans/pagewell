import type { PublicJob } from "@saas/contracts/jobs";
import { TOOLS, isActive, jobRequest, jobSummary, parsePages, primaryFile, toolFor } from "../../../apps/web-console-next/src/lib/jobs";

// The Run a tool dialog and the jobs tray (PW4): pure helpers.

const job = (over: Partial<PublicJob>): PublicJob => ({
  id: "job_1",
  orgId: "org_1",
  operation: "rotate",
  status: "queued",
  documentIds: ["doc_1"],
  version: 1,
  output: "version",
  result: null,
  error: null,
  pages: null,
  createdBy: "usr_1",
  createdAt: "2026-11-01T00:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  ...over,
});

describe("jobs helpers", () => {
  it("offers all twelve operations, the versioning ones marked", () => {
    expect(TOOLS).toHaveLength(12);
    expect(TOOLS.filter((t) => t.versioning).map((t) => t.operation)).toEqual(["ocr", "compress", "rotate", "flatten", "redact", "sanitize"]);
  });

  it("reads page lists and ranges within the document", () => {
    expect(parsePages("1, 3-5, 3", 10)).toEqual([1, 3, 4, 5]);
    expect(parsePages("0", 10)).toBeNull();
    expect(parsePages("4-2", 10)).toBeNull();
    expect(parsePages("11", 10)).toBeNull();
    expect(parsePages("one", 10)).toBeNull();
    expect(parsePages("", 10)).toBeNull();
  });

  it("builds each job the API expects, and says what is wrong", () => {
    expect(jobRequest("rotate", "doc_1", 5, { degrees: 180, pages: "1-2" })).toEqual({ ok: true, request: { operation: "rotate", documentIds: ["doc_1"], options: { degrees: 180, pages: [1, 2] }, output: "version" } });
    expect(jobRequest("ocr", "doc_1", 5, { output: "document" })).toEqual({ ok: true, request: { operation: "ocr", documentIds: ["doc_1"], options: { force: true }, output: "document" } });
    expect(jobRequest("merge", "doc_1", 5, { mergeWith: ["doc_2", "doc_3"] })).toEqual({ ok: true, request: { operation: "merge", documentIds: ["doc_1", "doc_2", "doc_3"], options: {} } });
    expect(jobRequest("render", "doc_1", 5, {})).toEqual({ ok: true, request: { operation: "render", documentIds: ["doc_1"], options: { dpi: 96, pages: [1] } } });
    expect(jobRequest("split", "doc_1", 5, { every: 2 })).toMatchObject({ ok: true, request: { options: { every: 2 } } });
    expect(jobRequest("extract", "doc_1", 5, {})).toEqual({ ok: false, error: "Which pages to extract?" });
    expect(jobRequest("merge", "doc_1", 5, {})).toMatchObject({ ok: false });
    expect(jobRequest("rotate", "doc_1", 5, { pages: "9" })).toMatchObject({ ok: false });
    expect(jobRequest("split", "doc_1", 5, { every: 9 })).toMatchObject({ ok: false });
  });

  it("sums a job up for the tray, and finds the file to open", () => {
    expect(jobSummary(job({}))).toBe("Rotate pages: waiting to start");
    expect(jobSummary(job({ status: "succeeded", result: { documents: [{ id: "doc_1", version: 4 }], files: [] } }))).toBe("Rotate pages: saved as version 4");
    expect(jobSummary(job({ operation: "split", output: "document", status: "succeeded", result: { documents: [{ id: "a", version: 1 }, { id: "b", version: 1 }], files: [] } }))).toBe("Split: made 2 documents");
    expect(jobSummary(job({ status: "failed", error: { code: "version_conflict", message: "The document changed" } }))).toBe("Rotate pages failed: The document changed");
    const printed = job({ operation: "print", output: "files", status: "succeeded", result: { documents: [], files: [{ name: "result.pdf", type: "application/pdf", size: 1 }] } });
    expect(jobSummary(printed)).toBe("Print-ready PDF: ready");
    expect(primaryFile(printed)).toBe("result.pdf");
    expect(primaryFile(job({}))).toBeNull();
    expect([isActive(job({})), isActive(job({ status: "running" })), isActive(job({ status: "failed" }))]).toEqual([true, true, false]);
    expect(toolFor("text").label).toBe("Extract text");
  });
});
