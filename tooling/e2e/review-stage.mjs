#!/usr/bin/env node
// Review, end to end on a deployed environment (PW5): an owner, a reviewer (a guest), two live
// connections to the document's room over real WebSockets, generated PDFs only.
//
//   node tooling/e2e/review-stage.mjs [--api https://pagewell-api-edge-stage.<sub>.workers.dev]
//
// Signs in with the magic-link codes stage returns inline (refuses elsewhere). Tokens and room
// tickets stay in memory and are never printed.

const arg = (n, f) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : f;
};
const API = arg("api", "https://pagewell-api-edge-stage.vijayakrishnan12994.workers.dev").replace(/\/$/, "");
const WS = API.replace(/^http/, "ws");
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

function fixturePdf(pages) {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages} >>`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  for (let i = 0; i < pages; i++) {
    const text = `BT /F1 20 Tf 72 700 Td (Generated page ${i + 1}. Nothing here is a real document.) Tj ET`;
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

async function signIn(who, withOrg) {
  const email = `pw-review-${who}-${run}@example.com`;
  const s = await data(await call(null, "POST", "/v1/auth/login/start", { json: { email } }));
  if (s?.delivery?.mode !== "local_debug") {
    console.error("This environment does not return login codes inline (not stage?); stopping.");
    process.exit(2);
  }
  const done = await data(await call(null, "POST", "/v1/auth/login/complete", { json: { challengeId: s.challengeId, code: s.delivery.code } }));
  let orgId = null;
  if (withOrg) orgId = (await data(await call(done.token, "POST", "/v1/organizations", { json: { name: `Review${who}`, slug: `review-${who}-${run}` } }))).organization.id;
  check(`sign in ${who}`, Boolean(done.token));
  return { token: done.token, email, orgId };
}

/** A live room connection: collects what the room sends. */
async function join(token, A, docId) {
  const res = await call(token, "POST", `${A}/documents/${docId}/room/ticket`);
  if (res.status !== 201) return { status: res.status };
  const t = await data(res);
  const ws = new WebSocket(`${WS}${A}/documents/${docId}/room?ticket=${encodeURIComponent(t.ticket)}`);
  const events = [];
  ws.addEventListener("message", (e) => events.push(JSON.parse(String(e.data))));
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("WebSocket failed")), { once: true });
  });
  const waitFor = async (pred, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = [...events].reverse().find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  };
  return { status: 201, ws, events, waitFor, ticket: t.ticket, canEdit: t.canEdit };
}

const owner = await signIn("owner", true);
const guest = await signIn("guest", false);
const A = `/v1/organizations/${owner.orgId}`;
const doc = (await data(await call(owner.token, "POST", `${A}/documents?name=Review%20${run}.pdf`, { body: fixturePdf(3), headers: { "content-type": "application/pdf", "x-pagewell-page-count": "3" } }))).document;
check("upload a generated PDF", Boolean(doc?.id));
await call(owner.token, "PUT", `${A}/documents/${doc.id}/versions/1/text`, { json: { pages: [{ page: 1, text: "Cover" }, { page: 2, text: "The payment terms are thirty days." }, { page: 3, text: "Signatures" }] } });

// The guest is asked to review: shared as a commenter, by email.
let res = await call(owner.token, "POST", `${A}/documents/${doc.id}/review-requests`, { json: { reviewers: [guest.email], message: "Generated test review" } });
check("ask the guest to review", res.status === 201, `status ${res.status}`);
const request = (await data(res)).request;

// Both join the room live.
const ownerRoom = await join(owner.token, A, doc.id);
check("owner joins the room over a WebSocket (ticketed)", ownerRoom.status === 201 && ownerRoom.canEdit === true);
const guestRoom = await join(guest.token, A, doc.id);
check("guest joins the room as a commenter, not an editor", guestRoom.status === 201 && guestRoom.canEdit === false);
check("presence shows both", Boolean(await ownerRoom.waitFor((e) => e.type === "presence" && e.people.length === 2)));
const reused = new WebSocket(`${WS}${A}/documents/${doc.id}/room?ticket=${encodeURIComponent(ownerRoom.ticket)}`);
const reuseOutcome = await new Promise((resolve) => {
  reused.addEventListener("open", () => resolve("open"), { once: true });
  reused.addEventListener("error", () => resolve("refused"), { once: true });
  setTimeout(() => resolve("timeout"), 8000);
});
check("a used ticket is refused", reuseOutcome === "refused", reuseOutcome);
const stranger = await signIn("stranger", true);
check("a stranger gets no ticket", (await join(stranger.token, A, doc.id)).status === 404);

// The edit lease: the owner takes it; the guest cannot.
ownerRoom.ws.send(JSON.stringify({ type: "lease.take" }));
check("the owner holds the edit lease, and the guest sees it", Boolean(await guestRoom.waitFor((e) => e.type === "lease" && e.holder?.name === owner.email)));
guestRoom.ws.send(JSON.stringify({ type: "lease.take" }));
await new Promise((r) => setTimeout(r, 1000));
check("the guest cannot take it", guestRoom.events.filter((e) => e.type === "lease").every((e) => !e.holder || e.holder.name === owner.email));

// A comment from the guest appears live for the owner.
res = await call(guest.token, "POST", `${A}/documents/${doc.id}/threads`, { json: { anchor: { page: 2, rect: [72, 100, 200, 20], quote: "payment terms" }, body: `Please confirm @${owner.email}` } });
check("the guest comments on page 2", res.status === 201, `status ${res.status}`);
const thread = (await data(res)).thread;
check("the comment appears live in the owner's room", Boolean(await ownerRoom.waitFor((e) => e.type === "thread" && e.thread.id === thread.id)));
res = await call(owner.token, "POST", `${A}/threads/${thread.id}/comments`, { json: { body: "Confirmed." } });
check("the owner's reply appears live for the guest", res.status === 201 && Boolean(await guestRoom.waitFor((e) => e.type === "thread" && e.thread.comments.length === 2)));

// A new version: the quote still there keeps the thread; one whose page text changed goes outdated.
const pinned = (await data(await call(owner.token, "POST", `${A}/documents/${doc.id}/threads`, { json: { anchor: { page: 3, rect: [72, 600, 200, 30], quote: null }, body: "Signature block" } }))).thread;
res = await call(owner.token, "POST", `${A}/documents/${doc.id}/versions`, { body: fixturePdf(3), headers: { "content-type": "application/pdf", "x-pagewell-base-version": "1" } });
check("the owner saves version 2", res.status === 201);
await call(owner.token, "PUT", `${A}/documents/${doc.id}/versions/2/text`, { json: { pages: [{ page: 1, text: "Cover" }, { page: 2, text: "The payment terms are sixty days." }, { page: 3, text: "Signatures, changed" }] } });
ownerRoom.ws.send(JSON.stringify({ type: "version", version: 2 }));
check("the guest is told there is a version 2", Boolean(await guestRoom.waitFor((e) => e.type === "version" && e.version === 2)));
const threads = (await data(await call(guest.token, "GET", `${A}/documents/${doc.id}/threads`))).threads;
const by = (id) => threads.find((t) => t.id === id);
check("the quoted thread is carried to version 2", by(thread.id)?.version === 2 && by(thread.id)?.status === "open", JSON.stringify(by(thread.id)));
check("the thread on a changed page is outdated, not moved", by(pinned.id)?.status === "outdated" && by(pinned.id)?.anchor.page === 3);

// The guest decides; the request closes.
res = await call(guest.token, "POST", `${A}/review-requests/${request.id}/decision`, { json: { decision: "approved" } });
check("the guest approves; the request closes", res.status === 200 && (await data(res)).request.status === "closed");

// Leaving frees the lease.
ownerRoom.ws.close();
check("when the owner leaves, the lease is freed", Boolean(await guestRoom.waitFor((e) => e.type === "lease" && e.holder === null)));
guestRoom.ws.close();

// Isolation, and the audit trail.
check("a stranger cannot read the threads", (await call(stranger.token, "GET", `${A}/documents/${doc.id}/threads`)).status === 404);
const audit = (await data(await call(owner.token, "GET", `${A}/audit?category=review&limit=100`))).auditEntries.map((e) => e.eventType);
check("the audit log has the review events", ["review_request.created", "thread.created", "comment.created", "review_request.decided"].every((t) => audit.includes(t)), audit.join(","));

console.log(`\n${passed} checks passed against ${API}`);
process.exit(0);
