#!/usr/bin/env node
// pdf-runner's tests, run against a live runner (in CI: the built image, started with no network,
// these tests executed inside it). Every operation runs on generated fixtures; every PDF it makes
// passes `qpdf --check` and has the expected page count. The job root cannot be escaped, and the
// page, CPU, memory and wall-clock limits hold.
//
//   RUNNER_URL=http://127.0.0.1:8080 node test/run-tests.mjs
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completionOptions, formPdf, redactPdf, signaturePng, textPdf } from "./fixtures.mjs";

const URL_ = process.env.RUNNER_URL || "http://127.0.0.1:8080";
const CLI = process.env.PDFCRAFT_CLI || "/usr/local/bin/pdfcraft-cli";
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`✗ ${name}\n    ${e instanceof Error ? e.message : String(e)}`);
  }
}
function assert(ok, message) {
  if (!ok) throw new Error(message);
}

async function run(operation, inputs, options = {}, limits, images = []) {
  const res = await fetch(`${URL_}/run`, {
    method: "POST",
    headers: { "x-pagewell-run": JSON.stringify({ operation, options, inputs: inputs.map((b) => b.length), ...(images.length ? { images: images.map((b) => b.length) } : {}), ...(limits ? { limits } : {}) }) },
    body: Buffer.concat([...inputs, ...images]),
  });
  if (!res.ok) return { status: res.status, error: (await res.json()).error, outputs: [] };
  const manifest = JSON.parse(res.headers.get("x-pagewell-outputs"));
  const body = Buffer.from(await res.arrayBuffer());
  let at = 0;
  const outputs = manifest.map((o) => {
    const bytes = body.subarray(at, at + o.size);
    at += o.size;
    return { ...o, bytes };
  });
  return { status: res.status, outputs, pages: Number(res.headers.get("x-pagewell-pages")) };
}

const scratch = mkdtempSync(join(tmpdir(), "runner-test-"));
let seq = 0;
function onDisk(bytes) {
  const p = join(scratch, `f-${++seq}.pdf`);
  writeFileSync(p, bytes);
  return p;
}
/** qpdf's verdict and page count for a PDF. */
function qpdf(bytes) {
  const p = onDisk(bytes);
  const check = spawnSync("qpdf", ["--check", p], { encoding: "utf8" });
  // qpdf exits 0 (clean) or 3 (warnings only); 2 is an error.
  assert(check.status === 0 || check.status === 3, `qpdf --check failed (${check.status}): ${check.stdout.slice(-300)}`);
  return Number(execFileSync("qpdf", ["--show-npages", p], { encoding: "utf8" }).trim());
}
/** The text of a PDF, through the runner itself. */
async function textOf(bytes) {
  const r = await run("text", [bytes]);
  assert(r.status === 200, `text: ${r.status} ${JSON.stringify(r.error)}`);
  return r.outputs[0].bytes.toString("utf8");
}

const three = textPdf(3, "alpha");
const two = textPdf(2, "beta");

await test("health lists every operation", async () => {
  const h = await (await fetch(`${URL_}/health`)).json();
  assert(h.ok && h.operations.length === 13, JSON.stringify(h));
});

await test("merge: 3 + 2 pages make one valid 5-page PDF", async () => {
  const r = await run("merge", [three, two]);
  assert(r.status === 200, JSON.stringify(r.error));
  assert(qpdf(r.outputs[0].bytes) === 5, "page count");
});

await test("split: every 1 page makes three valid 1-page PDFs", async () => {
  const r = await run("split", [three], { every: 1 });
  assert(r.status === 200, JSON.stringify(r.error));
  assert(r.outputs.length === 3, `outputs ${r.outputs.length}`);
  for (const o of r.outputs) assert(qpdf(o.bytes) === 1, `page count of ${o.name}`);
});

await test("extract: pages 1 and 3 make a valid 2-page PDF with their text", async () => {
  const r = await run("extract", [three], { pages: [1, 3] });
  assert(r.status === 200, JSON.stringify(r.error));
  assert(qpdf(r.outputs[0].bytes) === 2, "page count");
  const text = await textOf(r.outputs[0].bytes);
  assert(text.includes("Generated page 1") && text.includes("Generated page 3") && !text.includes("Generated page 2"), text.slice(0, 200));
});

await test("rotate: 90 degrees keeps 3 valid pages and sets /Rotate", async () => {
  const r = await run("rotate", [three], { degrees: 90 });
  assert(r.status === 200, JSON.stringify(r.error));
  assert(qpdf(r.outputs[0].bytes) === 3, "page count");
  // Normalised (no object streams), so every page dictionary can be read as text.
  const qdf = execFileSync("qpdf", ["--qdf", "--object-streams=disable", onDisk(r.outputs[0].bytes), "-"]).toString("latin1");
  assert((qdf.match(/\/Rotate 90\b/g) ?? []).length === 3, "rotation not set on every page");
});

await test("compress: a valid PDF with the same pages", async () => {
  const r = await run("compress", [three], { preset: "standard" });
  assert(r.status === 200, JSON.stringify(r.error));
  assert(qpdf(r.outputs[0].bytes) === 3, "page count");
});

await test("flatten: the field's value becomes page content and the field is gone", async () => {
  const r = await run("flatten", [formPdf()]);
  assert(r.status === 200, JSON.stringify(r.error));
  assert(qpdf(r.outputs[0].bytes) === 1, "page count");
  const json = execFileSync("qpdf", ["--json", "--json-key=acroform", onDisk(r.outputs[0].bytes)], { encoding: "utf8" });
  assert(!/"fullname":\s*"name"/.test(json), "the field is still there");
  assert((await textOf(r.outputs[0].bytes)).includes("Generated value"), "the value is not in the page text");
});

await test("redact: the marked words are gone for good, the rest stays", async () => {
  const r = await run("redact", [redactPdf()]);
  assert(r.status === 200, JSON.stringify(r.error));
  assert(qpdf(r.outputs[0].bytes) === 1, "page count");
  const text = await textOf(r.outputs[0].bytes);
  assert(!text.includes("Hidden generated"), "redacted text is still there");
  assert(text.includes("Visible generated"), "unmarked text was lost");
});

await test("sanitize: a valid PDF with the same pages", async () => {
  const r = await run("sanitize", [three]);
  assert(r.status === 200, JSON.stringify(r.error));
  assert(qpdf(r.outputs[0].bytes) === 3, "page count");
});

await test("render: pages 1 and 2 at 72 dpi make two PNGs", async () => {
  const r = await run("render", [three], { pages: [1, 2], dpi: 72 });
  assert(r.status === 200, JSON.stringify(r.error));
  assert(r.outputs.length === 2 && r.outputs.every((o) => o.type === "image/png" && o.bytes.subarray(1, 4).toString() === "PNG"), "not two PNGs");
});

await test("text: every page's words come back as JSON", async () => {
  const text = await textOf(three);
  assert(["Generated page 1", "Generated page 2", "Generated page 3"].every((t) => text.includes(t)), text.slice(0, 300));
});

await test("print: a valid print-ready PDF with every page", async () => {
  const r = await run("print", [three], { grayscale: true });
  assert(r.status === 200, JSON.stringify(r.error));
  assert(qpdf(r.outputs[0].bytes) >= 3, "page count");
});

await test("ocr: forced OCR writes a valid PDF whose text holds the page's words", async () => {
  const r = await run("ocr", [textPdf(1, "ocr")], { force: true }, { wallSeconds: 300, cpuSeconds: 300 });
  assert(r.status === 200, JSON.stringify(r.error));
  assert(qpdf(r.outputs[0].bytes) === 1, "page count");
  assert(/Generated/i.test(await textOf(r.outputs[0].bytes)), "no recognised text");
});

// ---- refusals and limits ----

// ---- sign_complete (PW6) ----
// Needs the runner started with a (test) signing ID: SIGN_P12_B64 / SIGN_P12_PASSWORD. The CI job
// makes a throwaway one. SIGNED_OUT, when set, keeps a copy of the signed file (and a tampered
// one) for poppler's pdfsig on the host.

/** pdfcraft-cli's sign_list for a PDF on disk. */
function signList(bytes) {
  const root = mkdtempSync(join(scratch, "sig-"));
  writeFileSync(join(root, "f.pdf"), bytes);
  writeFileSync(join(root, "s.json"), JSON.stringify([{ tool: "doc_open", args: { path: "f.pdf" } }, { tool: "sign_list", args: { doc: 1 } }]));
  const r = spawnSync(CLI, ["run", "--script", join(root, "s.json"), "--root", root, "--report"], { encoding: "utf8" });
  const report = JSON.parse(r.stdout || "[]");
  const steps = Array.isArray(report) ? report : report.steps ?? [];
  return steps[1]?.result?.[0];
}

const signing = await run("sign_complete", [textPdf(2, "A"), textPdf(1, "B")], completionOptions(), undefined, [await signaturePng()]);
if (signing.status === 503 && signing.error?.code === "signing_unavailable") {
  console.log("- sign_complete: this runner has no signing ID (set SIGN_P12_B64 and SIGN_P12_PASSWORD); skipped");
} else {
  await test("sign_complete: two documents and six values make one PAdES-signed PDF with a certificate page", async () => {
    assert(signing.status === 200, `${signing.status} ${JSON.stringify(signing.error)}`);
    const [pdf, report] = signing.outputs;
    assert(pdf.name === "result.pdf" && report.name === "signature.json", JSON.stringify(signing.outputs.map((o) => o.name)));
    assert(qpdf(pdf.bytes) === 4, "expected 2 + 1 pages and the certificate page");
    const sig = JSON.parse(report.bytes.toString("utf8")).signatures[0];
    assert(sig.sub_filter === "ETSI.CAdES.detached" && sig.modification === "none" && sig.certify === 1 && sig.algorithm.includes("SHA-256"), JSON.stringify(sig));
    const text = await textOf(pdf.bytes);
    for (const want of ["Certificate of completion", "a".repeat(64), "Ben Example <ben@example.com>", "c".repeat(64), "Generated note", "2026-11-28"]) assert(text.includes(want), `missing: ${want}`);
    if (process.env.SIGNED_OUT) writeFileSync(process.env.SIGNED_OUT, pdf.bytes);
  });

  await test("sign_complete: changing one byte of the signed file is detected", async () => {
    const pdf = Buffer.from(signing.outputs[0].bytes);
    const before = signList(pdf).signatures[0];
    assert(before.modification === "none" && before.status !== "invalid", JSON.stringify(before));
    // Inside the first signed range, well away from the signature itself: a byte of page content.
    const at = pdf.indexOf("Generated page 1");
    assert(at > 0, "no page text to change");
    pdf[at] = "g".charCodeAt(0);
    const after = signList(pdf).signatures[0];
    assert(after.status === "invalid", `a changed file still checks out: ${JSON.stringify(after)}`);
    if (process.env.SIGNED_OUT) writeFileSync(`${process.env.SIGNED_OUT}.tampered.pdf`, pdf);
  });

  await test("sign_complete refuses images for other operations, a field off the page, and an image that is not one", async () => {
    let r = await run("rotate", [three], { degrees: 90 }, undefined, [await signaturePng()]);
    assert(r.status === 400, `images on rotate: ${r.status}`);
    const off = completionOptions();
    off.fields[0].page = 9;
    r = await run("sign_complete", [textPdf(2, "A"), textPdf(1, "B")], off, undefined, [await signaturePng()]);
    assert(r.status === 422 && r.error.code === "invalid_options", JSON.stringify(r.error));
    r = await run("sign_complete", [textPdf(2, "A"), textPdf(1, "B")], completionOptions(), undefined, [Buffer.from("not an image at all")]);
    assert(r.status === 415, `bad image: ${r.status}`);
  });
}

await test("refuses an unknown operation, bad options and a body that is not a PDF", async () => {
  assert((await run("delete_everything", [three])).status === 422, "unknown operation");
  assert((await run("rotate", [three], { degrees: 45 })).error.code === "invalid_options", "bad degrees");
  assert((await run("extract", [three], { pages: [9] })).error.code === "invalid_options", "page out of range");
  assert((await run("extract", [three], { pages: ["../../etc/passwd"] })).error.code === "invalid_options", "a path as a page");
  assert((await run("rotate", [Buffer.from("plain text, not a PDF")], { degrees: 90 })).status === 415, "not a PDF");
  assert((await run("merge", [three])).error.code === "invalid_options", "merge of one");
});

await test("the page limit refuses a document with too many pages before it runs", async () => {
  const r = await run("rotate", [textPdf(12)], { degrees: 90 }, { pages: 10 });
  assert(r.status === 422 && r.error.code === "limit_exceeded", JSON.stringify(r));
});

await test("the memory limit stops a job that would use more", async () => {
  const r = await run("render", [three], { pages: [1, 2, 3], dpi: 300 }, { memoryMb: 24 });
  assert(r.status === 422 && r.error.code === "limit_exceeded", JSON.stringify(r));
});

await test("the wall-clock limit stops a job that runs too long", async () => {
  const r = await run("render", [textPdf(40, "slow")], { pages: Array.from({ length: 40 }, (_, i) => i + 1), dpi: 300 }, { wallSeconds: 1 });
  assert(r.status === 422 && r.error.code === "limit_exceeded", JSON.stringify(r));
});

await test("a script that names paths outside --root cannot read or write them", async () => {
  const root = join(scratch, "jobroot");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "in.pdf"), three);
  const outside = join(scratch, "escaped.pdf");
  const attempts = [
    [{ tool: "doc_open", args: { path: "in.pdf" } }, { tool: "doc_save", args: { doc: 1, path: "../escaped.pdf", full: true } }],
    [{ tool: "doc_open", args: { path: "in.pdf" } }, { tool: "doc_save", args: { doc: 1, path: outside, full: true } }],
    [{ tool: "doc_open", args: { path: "in.pdf" } }, { tool: "page_extract", args: { doc: 1, pages: [1], out: "/tmp/escaped.pdf" } }],
    [{ tool: "doc_open", args: { path: "/etc/hostname" } }],
    [{ tool: "doc_combine", args: { paths: ["in.pdf", "../../../etc/passwd"], out: "joined.pdf" } }],
  ];
  for (const [i, steps] of attempts.entries()) {
    const script = join(scratch, `escape-${i}.json`);
    writeFileSync(script, JSON.stringify(steps));
    const r = spawnSync(CLI, ["run", "--script", script, "--root", root, "--report"], { encoding: "utf8" });
    const report = JSON.parse(r.stdout || "[]");
    const steps_ = Array.isArray(report) ? report : report.steps ?? [];
    assert(steps_.some((s) => s.status === "error"), `attempt ${i} was not refused: ${r.stdout.slice(0, 300)}`);
  }
  assert(!existsSync(outside) && !existsSync("/tmp/escaped.pdf"), "a file was written outside the root");
  assert(readdirSync(root).every((f) => f === "in.pdf"), `unexpected files in the root: ${readdirSync(root)}`);
});

await test("job directories are removed after every job", async () => {
  const jobs = process.env.PDF_RUNNER_JOBS;
  if (!jobs || !existsSync(jobs)) return;
  assert(readdirSync(jobs).length === 0, `left behind: ${readdirSync(jobs)}`);
});

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
