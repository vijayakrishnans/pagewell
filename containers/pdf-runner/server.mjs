// pdf-runner (PW4): one container route, POST /run, that runs a PdfCraft operation on the PDFs in
// the request body and answers with what it made. No network is needed or used: the inputs come
// in the request, the outputs go back in the response (the Worker in front reads and writes R2).
//
//   POST /run
//     x-pagewell-run: {"operation":"rotate","options":{"degrees":90},"inputs":[<bytes of each input>],
//                      "limits":{"pages":500,"cpuSeconds":60,"memoryMb":1024,"wallSeconds":120}}
//     body: the inputs, back to back
//   200 x-pagewell-outputs: [{"name":"result.pdf","type":"application/pdf","size":1234}, …]
//       body: the outputs, back to back
//   4xx/5xx {"error":{"code","message"}}
//
// sign_complete (PW6) also takes drawn-signature images after the PDFs ("images": their sizes)
// and signs with the platform's digital ID, which only this container holds: SIGN_P12_B64 and
// SIGN_P12_PASSWORD in its environment (Worker secrets), written into the job's directory for the
// job and removed with it. Without them, sign_complete answers 503 signing_unavailable.
//
// Each job gets a fresh directory, removed afterwards. pdfcraft-cli runs with --root <jobdir>
// under prlimit (address space and CPU seconds) and a wall-clock timeout. Logs carry the job's
// operation, sizes and outcome, never a file's text.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPERATIONS, OptionError, plan } from "./operations.mjs";

const CLI = process.env.PDFCRAFT_CLI || "/usr/local/bin/pdfcraft-cli";
const JOBS = process.env.PDF_RUNNER_JOBS || join(tmpdir(), "pdf-runner");
// Hard ceilings: a request may ask for less, never more.
const HARD = {
  pages: Number(process.env.PDF_RUNNER_MAX_PAGES || 2000),
  cpuSeconds: Number(process.env.PDF_RUNNER_MAX_CPU_SECONDS || 300),
  memoryMb: Number(process.env.PDF_RUNNER_MAX_MEMORY_MB || 2048),
  wallSeconds: Number(process.env.PDF_RUNNER_MAX_WALL_SECONDS || 600),
  bodyBytes: Number(process.env.PDF_RUNNER_MAX_BODY_BYTES || 300 * 1024 * 1024),
  outputBytes: Number(process.env.PDF_RUNNER_MAX_OUTPUT_BYTES || 300 * 1024 * 1024),
};

class JobError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function log(fields) {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...fields })}\n`);
}

function limitsFrom(asked = {}) {
  const pick = (k) => {
    const v = asked?.[k];
    return Number.isFinite(v) && v > 0 ? Math.min(v, HARD[k]) : HARD[k];
  };
  return { pages: pick("pages"), cpuSeconds: pick("cpuSeconds"), memoryMb: pick("memoryMb"), wallSeconds: pick("wallSeconds") };
}

/** Run a pdfcraft-cli script in the job directory, confined and limited; resolve to its report. */
function runScript(jobdir, scriptName, limits) {
  return new Promise((resolve, reject) => {
    const args = [
      `--as=${limits.memoryMb * 1024 * 1024}`,
      `--cpu=${limits.cpuSeconds}`,
      "--",
      CLI,
      "run",
      "--script",
      join(jobdir, scriptName),
      "--root",
      jobdir,
      "--report",
    ];
    // A bare environment: nothing of the server's leaks into the job but where the OCR models are.
    const env = { PATH: process.env.PATH, HOME: jobdir, LANG: "C.UTF-8", ...(process.env.PDFCRAFT_MODELS ? { PDFCRAFT_MODELS: process.env.PDFCRAFT_MODELS } : {}) };
    const child = spawn("prlimit", args, { cwd: jobdir, stdio: ["ignore", "pipe", "pipe"], env });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      if (out.length < 64 * 1024 * 1024) out += d;
    });
    child.stderr.on("data", (d) => {
      if (err.length < 64 * 1024) err += d;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), limits.wallSeconds * 1000);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new JobError(500, "runner_failed", `could not start pdfcraft-cli: ${e.code ?? e.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal === "SIGKILL" || signal === "SIGXCPU") return reject(new JobError(422, "limit_exceeded", signal === "SIGXCPU" ? "the job used up its CPU time" : "the job ran out of time"));
      // Killed by anything else (an allocation refused under the address-space limit aborts,
      // or faults while mapping memory): the job ran out of memory.
      if (signal) return reject(new JobError(422, "limit_exceeded", "the job ran out of memory"));
      let report = null;
      try {
        report = JSON.parse(out);
      } catch {
        /* not a report */
      }
      if (!report) {
        const oom = /memory|alloc/i.test(err);
        return reject(new JobError(oom ? 422 : 500, oom ? "limit_exceeded" : "runner_failed", oom ? "the job ran out of memory" : `pdfcraft-cli exited ${code}`));
      }
      resolve({ report: Array.isArray(report) ? report : report.steps ?? [], code });
    });
  });
}

function failedStep(report) {
  return report.find((s) => s.status === "error");
}

/** The platform's digital ID, from the container's environment; never logged. */
function signingId() {
  const b64 = process.env.SIGN_P12_B64;
  const password = process.env.SIGN_P12_PASSWORD;
  if (!b64 || !password) throw new JobError(503, "signing_unavailable", "this runner has no signing identity");
  const p12 = Buffer.from(b64, "base64");
  if (p12.length < 100) throw new JobError(503, "signing_unavailable", "this runner's signing identity is unreadable");
  return { p12, password };
}

/** The signed file must carry exactly one PAdES signature covering the whole file, unchanged since. */
function checkSealed(step) {
  const list = step?.result?.[0];
  const sig = list?.signatures?.[0];
  const ok = list?.count === 1 && sig?.signed === true && sig?.modification === "none" && sig?.sub_filter === "ETSI.CAdES.detached" && sig?.status !== "invalid";
  if (!ok) throw new JobError(500, "runner_failed", "the signed file did not check out");
}

async function handleRun(req, res) {
  const started = Date.now();
  let header;
  try {
    header = JSON.parse(req.headers["x-pagewell-run"] ?? "");
  } catch {
    throw new JobError(400, "bad_request", "x-pagewell-run must be JSON");
  }
  const sizes = header?.inputs;
  if (!Array.isArray(sizes) || sizes.length < 1 || sizes.length > 50 || !sizes.every((s) => Number.isInteger(s) && s > 0)) {
    throw new JobError(400, "bad_request", "inputs: the byte size of each input, 1 to 50 of them");
  }
  const operation = header.operation;
  if (!OPERATIONS.includes(operation)) throw new JobError(422, "invalid_operation", `operation: one of ${OPERATIONS.join(", ")}`);
  const imageSizes = header.images ?? [];
  if (!Array.isArray(imageSizes) || imageSizes.length > 20 || !imageSizes.every((s) => Number.isInteger(s) && s > 0 && s <= 4 * 1024 * 1024)) {
    throw new JobError(400, "bad_request", "images: the byte size of each image, at most 20 of 4 MiB");
  }
  if (imageSizes.length && operation !== "sign_complete") throw new JobError(400, "bad_request", "only sign_complete takes images");
  const signing = operation === "sign_complete" ? signingId() : null;
  const total = sizes.reduce((a, b) => a + b, 0) + imageSizes.reduce((a, b) => a + b, 0);
  if (total > HARD.bodyBytes) throw new JobError(413, "too_large", "the inputs are too large");
  const limits = limitsFrom(header.limits);

  const chunks = [];
  let received = 0;
  for await (const chunk of req) {
    received += chunk.length;
    if (received > total) throw new JobError(400, "bad_request", "the body is longer than the inputs say");
    chunks.push(chunk);
  }
  if (received !== total) throw new JobError(400, "bad_request", "the body is shorter than the inputs say");
  const body = Buffer.concat(chunks, total);

  await mkdir(JOBS, { recursive: true });
  const jobdir = await mkdtemp(join(JOBS, "job-"));
  try {
    await mkdir(join(jobdir, "out"));
    let at = 0;
    for (let i = 0; i < sizes.length; i++) {
      const bytes = body.subarray(at, at + sizes[i]);
      at += sizes[i];
      if (bytes.subarray(0, 1024).indexOf("%PDF-") < 0) throw new JobError(415, "not_a_pdf", `input ${i + 1} is not a PDF`);
      await writeFile(join(jobdir, `in-${i}.pdf`), bytes);
    }
    const imageNames = [];
    for (let i = 0; i < imageSizes.length; i++) {
      const bytes = body.subarray(at, at + imageSizes[i]);
      at += imageSizes[i];
      const ext = bytes[0] === 0x89 && bytes.subarray(1, 4).toString("latin1") === "PNG" ? "png" : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? "jpg" : null;
      if (!ext) throw new JobError(415, "not_an_image", `image ${i + 1} is not a PNG or JPEG`);
      imageNames.push(`sig-${i}.${ext}`);
      await writeFile(join(jobdir, `sig-${i}.${ext}`), bytes);
    }
    if (signing) await writeFile(join(jobdir, "sign.p12"), signing.p12, { mode: 0o600 });

    // First pass: open every input to count its pages, against the page limit.
    await writeFile(join(jobdir, "count.json"), JSON.stringify(sizes.map((_, i) => ({ tool: "doc_open", args: { path: `in-${i}.pdf` } }))));
    const counted = await runScript(jobdir, "count.json", limits);
    const bad = failedStep(counted.report);
    if (bad) throw new JobError(422, "unreadable", `input ${bad.step} could not be opened`);
    const pageCounts = counted.report.map((s) => Number(s.result?.[0]?.pages ?? s.result?.[0]?.page_count ?? 0));
    const pages = pageCounts.reduce((a, b) => a + b, 0);
    if (pages > limits.pages) throw new JobError(422, "limit_exceeded", `${pages} pages is over this job's limit of ${limits.pages}`);

    let job;
    try {
      job = plan(operation, header.options ?? {}, sizes.length, pageCounts, { images: imageNames.length, imageNames, signPassword: signing?.password });
    } catch (e) {
      if (e instanceof OptionError) throw new JobError(422, "invalid_options", e.message);
      throw e;
    }
    await writeFile(join(jobdir, "job.json"), JSON.stringify(job.steps));
    const ran = await runScript(jobdir, "job.json", limits);
    const failed = failedStep(ran.report);
    if (failed) {
      let message = String(failed.error).replaceAll(jobdir, ".");
      if (signing) message = message.replaceAll(signing.password, "***");
      throw new JobError(422, "operation_failed", `${failed.tool}: ${message.slice(0, 500)}`);
    }
    if (operation === "sign_complete") checkSealed(ran.report[ran.report.length - 1]);

    const outputs = [];
    for (const o of job.outputs) {
      if (o.fromReport) {
        const step = ran.report[o.fromReport];
        outputs.push({ name: o.name, type: o.type, bytes: Buffer.from(JSON.stringify(step?.result?.[0] ?? null)) });
      } else if (o.dir) {
        const names = (await readdir(join(jobdir, o.dir))).filter((f) => f.endsWith(".pdf")).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
        for (const name of names) outputs.push({ name, type: o.type, bytes: await readFile(join(jobdir, o.dir, name)) });
      } else {
        const path = join(jobdir, "out", o.name);
        if (!(await stat(path).catch(() => null))) throw new JobError(500, "runner_failed", `the operation wrote no ${o.name}`);
        outputs.push({ name: o.name, type: o.type, bytes: await readFile(path) });
      }
    }
    const size = outputs.reduce((a, o) => a + o.bytes.length, 0);
    if (outputs.length === 0) throw new JobError(500, "runner_failed", "the operation wrote nothing");
    if (size > HARD.outputBytes) throw new JobError(422, "limit_exceeded", "the output is too large");
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(size),
      "x-pagewell-outputs": JSON.stringify(outputs.map((o) => ({ name: o.name, type: o.type, size: o.bytes.length }))),
      "x-pagewell-pages": String(pages),
    });
    for (const o of outputs) res.write(o.bytes);
    res.end();
    log({ msg: "job done", operation, inputs: sizes.length, inBytes: total, pages, outputs: outputs.length, outBytes: size, ms: Date.now() - started });
  } finally {
    await rm(jobdir, { recursive: true, force: true });
  }
}

export function createRunner() {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://runner");
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true, service: "pdf-runner", operations: OPERATIONS, limits: HARD }));
      }
      if (req.method === "POST" && url.pathname === "/run") return await handleRun(req, res);
      throw new JobError(404, "not_found", "Not found");
    } catch (e) {
      const status = e instanceof JobError ? e.status : 500;
      const code = e instanceof JobError ? e.code : "runner_failed";
      if (status >= 500) log({ msg: "job failed", code, error: e instanceof Error ? e.name : "unknown" });
      if (!res.headersSent) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code, message: e instanceof JobError ? e.message : "The runner failed" } }));
      } else res.destroy();
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 8080);
  createRunner().listen(port, () => log({ msg: "pdf-runner listening", port }));
}
