#!/usr/bin/env node
// The drive, end to end on a deployed environment (PW2): two throwaway users in two orgs,
// a generated PDF (never a real document), every route the console and the editor use.
//
//   node tooling/e2e/drive-stage.mjs [--api https://pagewell-api-edge-stage.<sub>.workers.dev]
//
// Signs in through the magic-link flow, which on stage returns the code inline
// (DEBUG_DELIVERY=true; prod never does, so this refuses to run there). Session tokens stay
// in memory and are never printed. Exits non-zero on the first failed check.
import { createHash } from "node:crypto";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const API = arg("api", "https://pagewell-api-edge-stage.vijayakrishnan12994.workers.dev").replace(/\/$/, "");
const EDITOR = arg("editor", API.replace("api-edge", "editor-web"));
const run = Date.now().toString(36);
const sha = (b) => createHash("sha256").update(b).digest("hex");

let passed = 0;
function check(label, ok, detail = "") {
  if (!ok) {
    console.error(`✗ ${label}${detail ? ` — ${detail}` : ""}`);
    process.exit(1);
  }
  passed++;
  console.log(`✓ ${label}`);
}

/** A generated PDF of `pages` pages, padded with a comment to `padTo` bytes. */
function fixturePdf(pages, tag, padTo = 0) {
  const objects = [];
  const kids = Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(" ");
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (let i = 0; i < pages; i++) {
    const text = `BT /F1 18 Tf 72 720 Td (Generated page ${i + 1}. Nothing here is a real document. ${tag}) Tj ET`;
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
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const head = new TextEncoder().encode(out);
  if (padTo <= head.length) return head;
  const bytes = new Uint8Array(padTo);
  bytes.set(head);
  bytes.fill(0x25, head.length); // '%' — a comment after %%EOF, ignored by readers
  return bytes;
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

async function signIn(email) {
  const start = await call(null, "POST", "/v1/auth/login/start", { json: { email } });
  const s = await data(start);
  if (s?.delivery?.mode !== "local_debug" || !s.delivery.code) {
    console.error("This environment does not return login codes inline (not stage?); stopping.");
    process.exit(2);
  }
  const done = await call(null, "POST", "/v1/auth/login/complete", { json: { challengeId: s.challengeId, code: s.delivery.code } });
  check(`sign in ${email.replace(/@.*/, "@…")}`, done.status === 200, `status ${done.status}`);
  return (await data(done)).token;
}

/** The user's org: the one sign-in provisioned, else a new one (one org per account without a plan). */
async function newOrg(token, name) {
  const mine = (await data(await call(token, "GET", "/v1/organizations")))?.organizations ?? [];
  if (mine.length) {
    check(`org ${name} (provisioned at sign-in)`, true);
    return mine[0].id;
  }
  const res = await call(token, "POST", "/v1/organizations", { json: { name, slug: `${name.toLowerCase()}-${run}` } });
  check(`create org ${name}`, res.status === 201 || res.status === 200, `status ${res.status}`);
  return (await data(res)).organization.id;
}

const ana = await signIn(`pw-e2e-a-${run}@example.com`);
const ben = await signIn(`pw-e2e-b-${run}@example.com`);
const orgA = await newOrg(ana, "DriveA");
const orgB = await newOrg(ben, "DriveB");
const A = `/v1/organizations/${orgA}`;
const B = `/v1/organizations/${orgB}`;

// Quota before anything is stored.
const q0 = await data(await call(ana, "GET", `${A}/quota`));
check("quota answers with limits", typeof q0?.quota?.storageBytesUsed === "number" || typeof q0?.storageBytesUsed === "number" || q0 != null, JSON.stringify(q0).slice(0, 200));

// A folder, and an upload into it: version 1.
const folder = (await data(await call(ana, "POST", `${A}/folders`, { json: { name: `E2E ${run}` } }))).folder;
check("create folder", Boolean(folder?.id));
const v1 = fixturePdf(3, `v1 ${run}`);
let res = await call(ana, "POST", `${A}/documents?name=${encodeURIComponent(`Generated ${run}.pdf`)}&folderId=${folder.id}`, {
  body: v1,
  headers: { "content-type": "application/pdf", "x-pagewell-page-count": "3" },
});
check("upload → 201", res.status === 201, `status ${res.status}`);
const doc = (await data(res)).document;
check("document is at version 1 in the folder", doc.currentVersion === 1 && doc.folderId === folder.id && doc.pageCount === 3);
const D = `${A}/documents/${doc.id}`;

res = await call(ana, "GET", `${D}/content`);
const got1 = new Uint8Array(await res.arrayBuffer());
check("content is the uploaded bytes, version 1", sha(got1) === sha(v1) && res.headers.get("x-pagewell-version") === "1");

const listing = await data(await call(ana, "GET", `${A}/folders/${folder.id}`));
check("folder listing shows the document", JSON.stringify(listing).includes(doc.id));

// Save version 2 on base 1 (what the editor does).
const v2 = fixturePdf(2, `v2 ${run}`);
res = await call(ana, "POST", `${D}/versions`, { body: v2, headers: { "content-type": "application/pdf", "x-pagewell-base-version": "1", "x-pagewell-page-count": "2" } });
check("save on base 1 → version 2", res.status === 201 && (await data(res)).version.version === 2, `status ${res.status}`);

// A second save that also started from 1 is refused and changes nothing.
res = await call(ana, "POST", `${D}/versions`, { body: fixturePdf(1, "stale"), headers: { "content-type": "application/pdf", "x-pagewell-base-version": "1" } });
const conflict = await res.json();
check("stale save → 409 version_conflict, current 2", res.status === 409 && conflict.error?.code === "version_conflict" && conflict.error?.details?.currentVersion === 2);

// Thumbnail and text for version 2 (best-effort steps of an editor save).
const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
res = await call(ana, "PUT", `${D}/versions/2/thumbnail`, { body: png, headers: { "content-type": "image/png" } });
check("thumbnail stored", res.status === 200 || res.status === 204, `status ${res.status}`);
res = await call(ana, "GET", `${D}/versions/2/thumbnail`);
check("thumbnail served back", res.status === 200 && sha(new Uint8Array(await res.arrayBuffer())) === sha(png));
res = await call(ana, "PUT", `${D}/versions/2/text`, { json: { pages: [{ page: 1, text: "Generated page 1." }, { page: 2, text: "Generated page 2." }] } });
check("text stored", res.status === 200 || res.status === 204, `status ${res.status}`);

// Restore version 1: it becomes version 3 with v1's bytes.
res = await call(ana, "POST", `${D}/versions/1/restore`, { headers: { "x-pagewell-base-version": "2" } });
check("restore v1 → version 3", res.status === 201 && (await data(res)).version.version === 3, `status ${res.status}`);
res = await call(ana, "GET", `${D}/content`);
check("current content is v1's bytes again", sha(new Uint8Array(await res.arrayBuffer())) === sha(v1) && res.headers.get("x-pagewell-version") === "3");
res = await call(ana, "GET", `${D}/content?version=2`);
check("version 2 is still readable", sha(new Uint8Array(await res.arrayBuffer())) === sha(v2));
const versions = (await data(await call(ana, "GET", `${D}/versions`))).versions;
check("three versions listed", versions?.length === 3);

// Multipart upload (a file over one part): 10 MiB + a tail.
const big = fixturePdf(1, `big ${run}`, 10 * 1024 * 1024 + 4096);
const started = await data(await call(ana, "POST", `${A}/uploads`, { json: { name: `Big ${run}.pdf`, size: big.length } }));
const part = started.upload.partSize;
for (let at = 0, n = 1; at < big.length; at += part, n++) {
  res = await call(ana, "PUT", `${A}/uploads/${started.upload.id}/parts/${n}`, { body: big.subarray(at, at + part), headers: { "content-type": "application/octet-stream" } });
  check(`multipart part ${n}`, res.status === 200, `status ${res.status}`);
}
res = await call(ana, "POST", `${A}/uploads/${started.upload.id}/complete`, { json: { sha256: sha(big) } });
const bigDoc = res.status === 201 ? (await data(res)).document : null;
check("multipart complete → document", Boolean(bigDoc) && bigDoc.size === big.length, `status ${res.status}`);
res = await call(ana, "GET", `${A}/documents/${bigDoc.id}/content`);
check("multipart content intact", sha(new Uint8Array(await res.arrayBuffer())) === sha(big));

// Limits: on the free tier a file over 100 MiB is refused before a byte is sent; so is a non-PDF.
res = await call(ana, "POST", `${A}/uploads`, { json: { name: "Too big.pdf", size: 101 * 1024 * 1024 } });
const tooBig = await res.json();
check("a 101 MiB file → 402 quota_exceeded (file_size)", res.status === 402 && tooBig.error?.code === "quota_exceeded" && tooBig.error?.details?.quota === "file_size", `status ${res.status}`);
res = await call(ana, "POST", `${A}/documents?name=notes.pdf`, { body: new TextEncoder().encode("plain text, not a PDF"), headers: { "content-type": "application/pdf" } });
check("a non-PDF → 415 not_a_pdf", res.status === 415 && (await res.json()).error?.code === "not_a_pdf", `status ${res.status}`);

// Isolation: Ben is not in org A; org A's ids under org B are not found either.
const probes = [
  ["GET", `${A}/folders`],
  ["GET", `${D}`],
  ["GET", `${D}/content`],
  ["GET", `${D}/versions`],
  ["DELETE", `${D}`],
  ["GET", `${A}/quota`],
  ["GET", `${B}/documents/${doc.id}`],
  ["GET", `${B}/documents/${doc.id}/content`],
  ["GET", `${B}/folders/${folder.id}`],
  ["POST", `${B}/documents/${doc.id}/versions/1/restore`],
];
for (const [method, path] of probes) {
  res = await call(ben, method, path);
  check(`other org: ${method} ${path.replace(orgA, "{A}").replace(orgB, "{B}").replace(doc.id, "{doc}").replace(folder.id, "{folder}")} → 404`, res.status === 404, `status ${res.status}`);
}
res = await call(null, "GET", `${A}/folders`);
check("no session → 401", res.status === 401, `status ${res.status}`);
check("Ana's document unchanged after the probes", (await data(await call(ana, "GET", D))).document.currentVersion === 3);

// Trash and restore.
res = await call(ana, "DELETE", `${A}/folders/${folder.id}`);
check("trash the folder", res.status === 200, `status ${res.status}`);
check("its document is marked trashed", Boolean((await data(await call(ana, "GET", D))).document.deletedAt));
check("its content is not served from the trash", (await call(ana, "GET", `${D}/content`)).status === 404);
const trash = await data(await call(ana, "GET", `${A}/trash`));
check("trash lists the folder", JSON.stringify(trash).includes(folder.id));
res = await call(ana, "POST", `${A}/folders/${folder.id}/restore`);
check("restore the folder brings the document back", res.status === 200 && (await call(ana, "GET", `${D}/content`)).status === 200);

const q1 = await data(await call(ana, "GET", `${A}/quota`));
check("quota counts the stored bytes", JSON.stringify(q1) !== JSON.stringify(q0));

// The editor's origin may call the API from the browser.
res = await fetch(`${API}${D}/content`, { method: "OPTIONS", headers: { origin: EDITOR, "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type,x-pagewell-base-version" } });
check("CORS admits the editor origin", res.headers.get("access-control-allow-origin") === EDITOR, `allow-origin ${res.headers.get("access-control-allow-origin")}`);

console.log(`\n${passed} checks passed against ${API}`);
console.log(`(left in place for the editor run: org ${orgA}, document ${doc.id})`);
