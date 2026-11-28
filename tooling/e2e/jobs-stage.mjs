#!/usr/bin/env node
// Heavy jobs, end to end on a deployed environment (PW4). A throwaway owner and a second org's
// owner, generated PDFs (never a real document).
//
//   node tooling/e2e/jobs-stage.mjs [--api https://pagewell-api-edge-stage.<sub>.workers.dev]
//
// While the runner is not deployed (WAITING W4) the API answers 503 runner_unavailable to a new
// job; this checks that and the read routes, then stops. Once the runner answers, it runs every
// operation and checks what each one made. Tokens stay in memory and are never printed.

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const API = arg("api", "https://pagewell-api-edge-stage.vijayakrishnan12994.workers.dev").replace(/\/$/, "");
const run = Date.now().toString(36);
let passed = 0;
function check(label, ok, detail = "") {
  if (!ok) {
    console.error(`✗ ${label}${detail ? ` — ${detail}` : ""}`);
    process.exit(1);
  }
  passed++;
  console.log(`✓ ${label}`);
}

function fixturePdf(pages, tag) {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages} >>`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  for (let i = 0; i < pages; i++) {
    const text = `BT /F1 24 Tf 72 700 Td (Generated page ${i + 1} ${tag}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
  }
  let out = "%PDF-1.7\n";
  const offsets = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

async function call(token, method, path, { body, headers = {}, json } = {}) {
  const h = new Headers(headers);
  if (token) h.set("authorization", `Bearer ${token}`);
  if (json !== undefined) {
    h.set("content-type", "application/json");
    body = JSON.stringify(json);
  }
  return fetch(API + path, { method, headers: h, body });
}
const data = async (res) => (await res.json()).data;

async function signIn(who) {
  const email = `pw-jobs-${who}-${run}@example.com`;
  const s = await data(await call(null, "POST", "/v1/auth/login/start", { json: { email } }));
  if (s?.delivery?.mode !== "local_debug") {
    console.error("This environment does not return login codes inline (not stage?); stopping.");
    process.exit(2);
  }
  const done = await data(await call(null, "POST", "/v1/auth/login/complete", { json: { challengeId: s.challengeId, code: s.delivery.code } }));
  const created = await call(done.token, "POST", "/v1/organizations", { json: { name: `Jobs${who}`, slug: `jobs-${who}-${run}` } });
  check(`sign in ${who} with a fresh org`, created.status === 201, `status ${created.status}`);
  return { token: done.token, orgId: (await data(created)).organization.id };
}

const owner = await signIn("owner");
const other = await signIn("other");
const A = `/v1/organizations/${owner.orgId}`;
const B = `/v1/organizations/${other.orgId}`;
const up = async (name, pages = 3) =>
  (await data(await call(owner.token, "POST", `${A}/documents?name=${encodeURIComponent(name)}`, { body: fixturePdf(pages, name), headers: { "content-type": "application/pdf" } }))).document;
const doc = await up(`Jobs ${run}.pdf`);
check("upload a generated PDF", Boolean(doc?.id));

check("the edge routes /jobs: an empty list", (await call(owner.token, "GET", `${A}/jobs`)).status === 200);
check("a missing job is 404", (await call(owner.token, "GET", `${A}/jobs/job_${"0".repeat(32)}`)).status === 404);
check("no session is 401", (await call(null, "GET", `${A}/jobs`)).status === 401);
// Without a runner every new job is 503 before any document is looked up (so nothing leaks); with one, 404.
const foreign = (await call(other.token, "POST", `${B}/jobs`, { json: { operation: "render", documentIds: [doc.id] } })).status;
check("another org cannot start a job on this document", foreign === 404 || foreign === 503, `status ${foreign}`);
check("bad input is 422", (await call(owner.token, "POST", `${A}/jobs`, { json: { operation: "format", documentIds: [doc.id] } })).status === 422);

let res = await call(owner.token, "POST", `${A}/jobs`, { json: { operation: "rotate", documentIds: [doc.id], options: { degrees: 90 } } });
if (res.status === 503) {
  const body = await res.json();
  check("without a runner, a new job is refused as runner_unavailable", body.error?.code === "runner_unavailable", JSON.stringify(body.error));
  console.log(`\n${passed} checks passed against ${API} (runner not deployed: WAITING W4)`);
  process.exit(0);
}

// The runner is live: every operation, and what it made.
const wait = async (id) => {
  for (let i = 0; i < 120; i++) {
    const job = (await data(await call(owner.token, "GET", `${A}/jobs/${id}`))).job;
    if (job.status !== "queued" && job.status !== "running") return job;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
};
check("rotate starts (202)", res.status === 202, `status ${res.status}`);
let job = await wait((await data(res)).job.id);
check("rotate saves version 2", job?.status === "succeeded" && job.result.documents[0]?.version === 2, JSON.stringify(job?.error));
const second = await up(`Second ${run}.pdf`, 2);
const cases = [
  ["compress", { documentIds: [doc.id] }, (j) => j.result.documents[0]?.version === 3],
  ["ocr", { documentIds: [doc.id], options: { force: true } }, (j) => j.result.documents[0]?.version === 4],
  ["merge", { documentIds: [doc.id, second.id] }, (j) => j.result.documents.length === 1],
  ["split", { documentIds: [doc.id], options: { every: 1 } }, (j) => j.result.documents.length === 3],
  ["extract", { documentIds: [doc.id], options: { pages: [1, 3] } }, (j) => j.result.documents.length === 1],
  ["flatten", { documentIds: [second.id] }, (j) => j.result.documents[0]?.version === 2],
  ["sanitize", { documentIds: [second.id] }, (j) => j.result.documents[0]?.version === 3],
  ["render", { documentIds: [doc.id], options: { pages: [1], dpi: 72 } }, (j) => j.result.files[0]?.name === "page-1.png"],
  ["text", { documentIds: [doc.id] }, (j) => j.result.files[0]?.name === "text.json"],
  ["print", { documentIds: [doc.id] }, (j) => j.result.files[0]?.name === "result.pdf"],
];
for (const [operation, body, made] of cases) {
  res = await call(owner.token, "POST", `${A}/jobs`, { json: { operation, ...body } });
  job = res.status === 202 ? await wait((await data(res)).job.id) : null;
  check(`${operation}: succeeds and makes what it should`, job?.status === "succeeded" && made(job), `status ${res.status} ${JSON.stringify(job?.error ?? job?.result)}`);
}
const printJob = job;
res = await call(owner.token, "GET", `${A}/jobs/${printJob.id}/files/result.pdf`);
const bytes = new Uint8Array(await res.arrayBuffer());
check("print's PDF downloads", res.status === 200 && new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-");
check("another org cannot read the job or its file", (await call(other.token, "GET", `${A}/jobs/${printJob.id}/files/result.pdf`)).status === 404);
console.log(`\n${passed} checks passed against ${API}`);
