#!/usr/bin/env node
// E-sign, end to end on a deployed environment (PW6): a sender, two signers with no account (links
// and email codes come back inline on stage), both signing orders, decline, void, the evidence
// chain and isolation. Generated PDFs only.
//
//   node tooling/e2e/sign-stage.mjs [--api https://pagewell-api-edge-stage.<sub>.workers.dev]
//
// Signs in with the magic-link codes stage returns inline (refuses elsewhere). Tokens and room
// codes stay in memory and are never printed.

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
  const email = `pw-sign-${who}-${run}@example.com`;
  const s = await data(await call(null, "POST", "/v1/auth/login/start", { json: { email } }));
  if (s?.delivery?.mode !== "local_debug") {
    console.error("This environment does not return login codes inline (not stage?); stopping.");
    process.exit(2);
  }
  const done = await data(await call(null, "POST", "/v1/auth/login/complete", { json: { challengeId: s.challengeId, code: s.delivery.code } }));
  let orgId = null;
  if (withOrg) orgId = (await data(await call(done.token, "POST", "/v1/organizations", { json: { name: `Sign${who}`, slug: `sign-${who}-${run}` } }))).organization.id;
  check(`sign in ${who}`, Boolean(done.token));
  return { token: done.token, email, orgId };
}


const owner = await signIn("owner", true);
const stranger = await signIn("stranger", true);
const A = `/v1/organizations/${owner.orgId}`;
const doc = (await data(await call(owner.token, "POST", `${A}/documents?name=Agreement%20${run}.pdf`, { body: fixturePdf(2), headers: { "content-type": "application/pdf", "x-pagewell-page-count": "2" } }))).document;
check("upload a generated PDF", Boolean(doc?.id));

const envelopeBody = (orderMode) => ({
  title: `Generated agreement ${orderMode}`,
  message: "Generated test envelope",
  orderMode,
  documents: [{ documentId: doc.id }],
  signers: [
    { key: "ann", name: "Ann Example", email: `pw-sign-ann-${run}@example.com`, order: 1 },
    { key: "ben", name: "Ben Example", email: `pw-sign-ben-${run}@example.com`, order: 2 },
  ],
  fields: [
    { signer: "ann", documentId: doc.id, page: 1, rect: [72, 600, 200, 40], kind: "signature" },
    { signer: "ann", documentId: doc.id, page: 1, rect: [300, 610, 120, 20], kind: "date" },
    { signer: "ben", documentId: doc.id, page: 2, rect: [72, 600, 200, 40], kind: "signature" },
  ],
});
const tokenOf = (url) => url.split("/s/")[1];
const signer = (token, method, rest = "", json) => call(null, method, `/v1/s/${token}${rest}`, json === undefined ? {} : { json });

async function signAs(token, value) {
  const code = (await data(await signer(token, "POST", "/code"))).delivery?.code;
  check("a code comes back inline on stage", /^\d{6}$/.test(code ?? ""));
  let res = await signer(token, "POST", "/verify", { code });
  check("the code verifies", res.status === 200, `status ${res.status}`);
  const s = (await data(await signer(token, "GET"))).session;
  const sig = s.fields.find((f) => f.kind === "signature");
  res = await signer(token, "POST", "/submit", { consent: true, values: [{ fieldId: sig.id, ...value }] });
  check("the signer signs", res.status === 200, `status ${res.status}`);
  return (await data(res)).envelopeStatus;
}

// Parallel.
let res = await call(owner.token, "POST", `${A}/envelopes`, { json: envelopeBody("parallel") });
check("draft a parallel envelope", res.status === 201, `status ${res.status}`);
let env = (await data(res)).envelope;
res = await call(owner.token, "POST", `${A}/envelopes/${env.id}/send`);
let sent = await data(res);
check("send it: the document is frozen with its hash", res.status === 200 && /^[0-9a-f]{64}$/.test(sent.envelope.documents[0].sha256) && sent.envelope.documents[0].version === 1);
check("both signers get links (parallel)", sent.delivery?.links?.length === 2);
const [annP, benP] = sent.delivery.links.map((l) => tokenOf(l.url));
const session = (await data(await signer(annP, "GET"))).session;
check("a signer sees only their own fields", session.fields.length === 2 && session.fields.every((f) => f.kind !== "checkbox") && session.others.length === 1);
check("the document opens only after verifying", (await signer(annP, "GET", `/documents/${doc.id}`)).status === 403);
check("a stranger cannot open the envelope", (await call(stranger.token, "GET", `${A}/envelopes/${env.id}`)).status === 404);
check("a guessed link is a 404", (await signer("x".repeat(43), "GET")).status === 404);
check("Ann signs (typed)", (await signAs(annP, { text: "Ann Example" })) === "sent");
check("Ann's link is spent", (await signer(annP, "GET")).status === 404);
const last = await signAs(benP, { text: "Ben Example" });
check("Ben signs; the envelope moves to completion", last === "completing" || last === "completed", last);
env = (await data(await call(owner.token, "GET", `${A}/envelopes/${env.id}`))).envelope;
check(`the envelope is ${env.status} (stage has no runner until W4: it waits)`, env.status === "completing" || env.status === "completed");
let ev = await data(await call(owner.token, "GET", `${A}/envelopes/${env.id}/evidence`));
check("the evidence chain verifies", ev.verdict.ok === true, JSON.stringify(ev.verdict));
check("the evidence has every step", ["envelope.created", "envelope.sent", "signer.viewed", "signer.verified", "signer.signed", "envelope.all_signed"].every((k) => ev.events.some((e) => e.kind === k)), ev.events.map((e) => e.kind).join(","));

// Sequential.
env = (await data(await call(owner.token, "POST", `${A}/envelopes`, { json: envelopeBody("sequential") }))).envelope;
sent = await data(await call(owner.token, "POST", `${A}/envelopes/${env.id}/send`));
check("sequential: only the first signer gets a link", sent.delivery.links.length === 1 && sent.delivery.links[0].signerId === sent.envelope.signers[0].id);
check("Ann signs first", (await signAs(tokenOf(sent.delivery.links[0].url), { text: "Ann Example" })) === "sent");
const resent = await data(await call(owner.token, "POST", `${A}/envelopes/${env.id}/resend`));
check("now it is Ben's turn", resent.delivery.links.length === 1 && resent.delivery.links[0].signerId === sent.envelope.signers[1].id);
const seqLast = await signAs(tokenOf(resent.delivery.links[0].url), { text: "Ben Example" });
check("Ben signs second; the envelope moves to completion", seqLast === "completing" || seqLast === "completed", seqLast);

// Decline and void.
env = (await data(await call(owner.token, "POST", `${A}/envelopes`, { json: envelopeBody("parallel") }))).envelope;
sent = await data(await call(owner.token, "POST", `${A}/envelopes/${env.id}/send`));
res = await signer(tokenOf(sent.delivery.links[1].url), "POST", "/decline", { reason: "Generated decline" });
check("a signer declines", res.status === 200);
check("the other link stops working", (await signer(tokenOf(sent.delivery.links[0].url), "GET")).status === 404);
check("the envelope is declined", (await data(await call(owner.token, "GET", `${A}/envelopes/${env.id}`))).envelope.status === "declined");
env = (await data(await call(owner.token, "POST", `${A}/envelopes`, { json: envelopeBody("parallel") }))).envelope;
sent = await data(await call(owner.token, "POST", `${A}/envelopes/${env.id}/send`));
res = await call(owner.token, "POST", `${A}/envelopes/${env.id}/void`, { json: { reason: "Generated void" } });
check("the sender voids one", res.status === 200 && (await data(res)).envelope.status === "voided");
check("its links stop working", (await signer(tokenOf(sent.delivery.links[0].url), "GET")).status === 404);
check("a stranger cannot void or read evidence", (await call(stranger.token, "POST", `${A}/envelopes/${env.id}/void`)).status === 404 && (await call(stranger.token, "GET", `${A}/envelopes/${env.id}/evidence`)).status === 404);

const audit = (await data(await call(owner.token, "GET", `${A}/audit?category=sign&limit=100`))).auditEntries.map((e) => e.eventType);
check("the audit log has the e-sign events", ["envelope.created", "envelope.sent", "envelope.signed", "envelope.declined", "envelope.voided"].every((t) => audit.includes(t)), audit.join(","));

console.log(`\n${passed} checks passed against ${API}`);
process.exit(0);
