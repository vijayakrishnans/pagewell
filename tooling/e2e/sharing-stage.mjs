#!/usr/bin/env node
// Sharing, end to end on a deployed environment (PW3): an owner, an invited org viewer, a guest
// outside the org and a second org's owner; a generated PDF (never a real document); grants with
// folder inheritance, a guest by email, a password link revoked mid-run, the audit trail, and
// isolation between orgs.
//
//   node tooling/e2e/sharing-stage.mjs [--api https://pagewell-api-edge-stage.<sub>.workers.dev]
//
// Signs in through the magic-link flow, which on stage returns the code inline (DEBUG_DELIVERY);
// prod never does, so this refuses to run there. Tokens stay in memory and are never printed.
import { createHash } from "node:crypto";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const API = arg("api", "https://pagewell-api-edge-stage.vijayakrishnan12994.workers.dev").replace(/\/$/, "");
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

function fixturePdf(pages, tag) {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages} >>`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
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
  const email = `pw-share-${who}-${run}@example.com`;
  const s = await data(await call(null, "POST", "/v1/auth/login/start", { json: { email } }));
  if (s?.delivery?.mode !== "local_debug") {
    console.error("This environment does not return login codes inline (not stage?); stopping.");
    process.exit(2);
  }
  const done = await call(null, "POST", "/v1/auth/login/complete", { json: { challengeId: s.challengeId, code: s.delivery.code } });
  check(`sign in ${who}`, done.status === 200, `status ${done.status}`);
  return { token: (await data(done)).token, email };
}

/** The person's first org: created here (team profile: nothing is made at sign-in). */
async function firstOrg(token, name) {
  const mine = (await data(await call(token, "GET", "/v1/organizations")))?.organizations ?? [];
  if (mine.length) return mine[0].id;
  const res = await call(token, "POST", "/v1/organizations", { json: { name, slug: `${name.toLowerCase()}-${run}` } });
  check(`create org ${name}`, res.status === 201, `status ${res.status}`);
  return (await data(res)).organization.id;
}

const owner = await signIn("owner");
const viewer = await signIn("viewer");
const guest = await signIn("guest");
const other = await signIn("other");

// Team profile: a new user has no org until they make one.
const guestOrgs = (await data(await call(guest.token, "GET", "/v1/organizations"))).organizations;
check("team profile: no org is created at sign-in", guestOrgs.length === 0, `found ${guestOrgs.length}`);

const orgA = await firstOrg(owner.token, "ShareA");
const orgB = await firstOrg(other.token, "ShareB");
const A = `/v1/organizations/${orgA}`;
const B = `/v1/organizations/${orgB}`;

// The viewer joins org A by invitation (team profile: members and invitations work).
let res = await call(owner.token, "POST", `${A}/invitations`, { json: { email: viewer.email, role: "viewer" } });
check("invite a viewer into org A", res.status === 201, `status ${res.status}`);
const invite = await data(res);
res = await call(viewer.token, "POST", `${A}/invitations/accept`, { json: { token: invite.delivery?.token } });
check("the viewer accepts", res.status === 200 || res.status === 201, `status ${res.status}`);

// A folder with a document in it, and a document outside it.
const folder = (await data(await call(owner.token, "POST", `${A}/folders`, { json: { name: `Shared ${run}` } }))).folder;
const upload = async (name, folderId) => {
  const q = new URLSearchParams({ name, ...(folderId ? { folderId } : {}) });
  const r = await call(owner.token, "POST", `${A}/documents?${q}`, { body: fixturePdf(2, name), headers: { "content-type": "application/pdf" } });
  return (await data(r)).document;
};
const inside = await upload(`Inside ${run}.pdf`, folder.id);
const outside = await upload(`Outside ${run}.pdf`, null);
check("owner uploads inside and outside the folder", Boolean(inside?.id && outside?.id));

// Before sharing: the guest sees nothing; the viewer reads but cannot write.
check("guest: no access before sharing", (await call(guest.token, "GET", `${A}/documents/${inside.id}/content`)).status === 404);
check("viewer: reads by role", (await call(viewer.token, "GET", `${A}/documents/${inside.id}/content`)).status === 200);
check("viewer: cannot rename by role", (await call(viewer.token, "PATCH", `${A}/documents/${inside.id}`, { json: { name: "No.pdf" } })).status === 404);

// Share the folder with the guest by email (viewer), and with the viewer (editor).
res = await call(owner.token, "POST", `${A}/folders/${folder.id}/grants`, { json: { email: guest.email, role: "viewer", message: "Generated test share" } });
check("share the folder with a guest by email", res.status === 201, `status ${res.status}`);
const members = (await data(await call(owner.token, "GET", `${A}/members`))).members;
const viewerId = members.find((m) => m.roles?.some?.((r) => r.role === "viewer"))?.subjectId;
res = await call(owner.token, "POST", `${A}/folders/${folder.id}/grants`, { json: { userId: viewerId, role: "editor" } });
check("grant the org viewer editor on the folder", res.status === 201, `status ${res.status}`);

// The guest reaches what is in the folder, read only, and nothing else.
check("guest: opens the document in the shared folder", (await call(guest.token, "GET", `${A}/documents/${inside.id}/content`)).status === 200);
check("guest: not the document outside it", (await call(guest.token, "GET", `${A}/documents/${outside.id}/content`)).status === 404);
check("guest: cannot edit as a viewer", (await call(guest.token, "PATCH", `${A}/documents/${inside.id}`, { json: { name: "No.pdf" } })).status === 404);
check("guest: not the org root", (await call(guest.token, "GET", `${A}/folders`)).status === 404);
check("guest: cannot share", (await call(guest.token, "POST", `${A}/documents/${inside.id}/grants`, { json: { email: "x@example.com", role: "viewer" } })).status === 404);
const shared = (await data(await call(guest.token, "GET", "/v1/me/shared"))).items;
check("guest: Shared with me lists the folder", shared.some((i) => i.resource.id === folder.id && i.role === "viewer"));
const access = (await data(await call(guest.token, "GET", `${A}/documents/${inside.id}/access`))).access;
check("guest: access says viewer, as a guest", access.role === "viewer" && access.principal === "guest");

// The viewer's grant widens their floor on the folder only.
check("viewer: edits in the shared folder", (await call(viewer.token, "PATCH", `${A}/documents/${inside.id}`, { json: { name: `Edited ${run}.pdf` } })).status === 200);
check("viewer: still not outside it", (await call(viewer.token, "PATCH", `${A}/documents/${outside.id}`, { json: { name: "No.pdf" } })).status === 404);

// The access list shows the inherited grants on the document.
const list = await data(await call(owner.token, "GET", `${A}/documents/${inside.id}/grants`));
check("access list: both grants, inherited from the folder", list.grants.length === 2 && list.grants.every((g) => g.inheritedFrom?.folderId === folder.id));
check("access list: the guest has opened it (verified)", list.grants.some((g) => g.principal.kind === "guest" && g.principal.verified));

// A password link, opened with no account, then revoked: the next request is a 404.
res = await call(owner.token, "POST", `${A}/documents/${inside.id}/links`, { json: { role: "viewer", password: "generated pass", allowDownload: false } });
check("create a password link", res.status === 201, `status ${res.status}`);
const { link, token: linkToken } = await data(res);
const L = `/v1/l/${linkToken}`;
check("link without its password → 401", (await call(null, "GET", L)).status === 401);
check("link with a wrong password → 401", (await call(null, "GET", L, { headers: { "x-pagewell-link-password": "wrong pass!" } })).status === 401);
const pw = { headers: { "x-pagewell-link-password": "generated pass" } };
res = await call(null, "GET", L, pw);
const opened = res.status === 200 ? await data(res) : null;
check("link with its password opens the document, owner hidden", opened?.document?.id === inside.id && opened.document.ownerUserId === "");
res = await call(null, "GET", `${L}/content`, pw);
const bytes = new Uint8Array(await res.arrayBuffer());
check("link serves the PDF, not cached, download off", res.status === 200 && res.headers.get("cache-control") === "no-store" && res.headers.get("x-pagewell-allow-download") === "0" && bytes.length > 100);
check("link cannot write", (await call(null, "POST", `${L}/content`, pw)).status === 405);
check("revoke the link", (await call(owner.token, "DELETE", `${A}/documents/${inside.id}/links/${link.id}`)).status === 204);
check("revoked link → 404 on the very next request", (await call(null, "GET", L, pw)).status === 404);
check("revoked link content → 404", (await call(null, "GET", `${L}/content`, pw)).status === 404);

// Isolation: the guest's grant in A means nothing in B; B's owner reaches nothing in A.
check("guest: nothing in org B", (await call(guest.token, "GET", `${B}/folders/${folder.id}`)).status === 404);
for (const [method, path] of [
  ["GET", `${A}/documents/${inside.id}/content`],
  ["GET", `${A}/folders/${folder.id}/grants`],
  ["POST", `${A}/folders/${folder.id}/grants`],
  ["GET", `${A}/guests`],
  ["GET", `${B}/documents/${inside.id}/access`],
]) {
  const r = await call(other.token, method, path, method === "POST" ? { json: { email: "x@example.com", role: "viewer" } } : {});
  check(`org B's owner: ${method} ${path.replace(orgA, "{A}").replace(orgB, "{B}").replace(inside.id, "{doc}").replace(folder.id, "{folder}")} → 404`, r.status === 404, `status ${r.status}`);
}

// Removing the guest takes their access at once.
const guests = (await data(await call(owner.token, "GET", `${A}/guests`))).guests;
check("org A lists the guest", guests.some((g) => g.email === guest.email));
const gst = guests.find((g) => g.email === guest.email).id;
check("remove the guest", (await call(owner.token, "DELETE", `${A}/guests/${gst}`)).status === 204);
check("guest: access gone at once", (await call(guest.token, "GET", `${A}/documents/${inside.id}/content`)).status === 404);

// The audit trail: the document's activity and the org's audit log show every share event.
const activity = (await data(await call(owner.token, "GET", `${A}/documents/${inside.id}/activity?limit=100`))).entries.map((e) => e.type);
check("activity: link created, opened, revoked; renamed; uploaded", ["link.revoked", "link.opened", "link.created", "document.renamed", "document.created"].every((t) => activity.includes(t)), activity.join(","));
res = await call(owner.token, "GET", `${A}/audit?category=files&limit=100`);
const auditBody = res.ok ? (await res.json()).data : null;
const audit = auditBody?.auditEntries ?? [];
const auditTypes = audit.map((e) => e.eventType ?? e.type);
check(
  "org audit log: every share event",
  ["guest.invited", "grant.created", "guest.verified", "link.created", "link.opened", "link.revoked", "guest.removed"].every((t) => auditTypes.includes(t)),
  `status ${res.status}: ${auditTypes.join(",")}`,
);
check("audit never holds the link token", !JSON.stringify(audit).includes(linkToken));

console.log(`\n${passed} checks passed against ${API}`);
console.log(`(sha of the shared PDF as served: ${sha(bytes).slice(0, 12)}…)`);
