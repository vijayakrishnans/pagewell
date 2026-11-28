import { createHash } from "node:crypto";
import { toPublic } from "@sign-worker/ids";
import { fixturePdf, signWorld, type SignWorld } from "./harness.js";

// E-sign (PW6) through sign-worker's router, against the real files-worker: who may send, the
// documents frozen at send, links and email codes, both signing orders, drawn signatures,
// completion through the runner (faked here; the real sign_complete is tested on the runner
// image), the runner being away, declines, voids, expiry, reminders, the evidence chain, and
// isolation.

const ORG_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const ORG_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const A = `/v1/organizations/${toPublic("org", ORG_A)}`;
const B = `/v1/organizations/${toPublic("org", ORG_B)}`;
const ALICE = "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; // owner of A
const VERA = "usr_cccccccccccccccccccccccccccccccc"; // viewer of A
const BOB = "usr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"; // owner of B
const AE = "alice@example.com";
const DAY = 86_400_000;

type Json = { data: Record<string, any>; error?: { code: string; details?: Record<string, any> } }; // eslint-disable-line @typescript-eslint/no-explicit-any
const json = async (r: Response) => (await r.json()) as Json;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function setup(): SignWorld {
  const w = signWorld();
  w.files.directory.add(ALICE, ORG_A, "owner");
  w.files.directory.add(VERA, ORG_A, "viewer");
  w.files.directory.add(BOB, ORG_B, "owner");
  return w;
}

async function upload(w: SignWorld, pages = 2, name = "Agreement.pdf") {
  const r = await w.files.request("POST", `${A}/documents?name=${encodeURIComponent(name)}`, { user: ALICE, body: fixturePdf(pages), headers: { "content-type": "application/pdf", "x-pagewell-page-count": String(pages) } });
  return (await json(r)).data.document as { id: string };
}

const body = (docId: string, orderMode: "parallel" | "sequential" = "parallel", extra: Record<string, unknown> = {}) => ({
  title: "Generated agreement",
  message: "Please sign",
  orderMode,
  documents: [{ documentId: docId }],
  signers: [
    { key: "ann", name: "Ann Example", email: "Ann@Example.com", order: 1 },
    { key: "ben", name: "Ben Example", email: "ben@example.com", order: 2 },
  ],
  fields: [
    { signer: "ann", documentId: docId, page: 1, rect: [72, 600, 200, 40], kind: "signature" },
    { signer: "ann", documentId: docId, page: 1, rect: [300, 610, 120, 20], kind: "date" },
    { signer: "ben", documentId: docId, page: 2, rect: [72, 600, 200, 40], kind: "signature" },
    { signer: "ben", documentId: docId, page: 2, rect: [72, 500, 14, 14], kind: "checkbox", required: false },
  ],
  ...extra,
});

async function draftAndSend(w: SignWorld, orderMode: "parallel" | "sequential" = "parallel", extra: Record<string, unknown> = {}) {
  const doc = await upload(w);
  const created = await w.request("POST", `${A}/envelopes`, { user: ALICE, email: AE, json: body(doc.id, orderMode, extra) });
  expect(created.status).toBe(201);
  const env = (await json(created)).data.envelope;
  const sent = await json(await w.request("POST", `${A}/envelopes/${env.id}/send`, { user: ALICE, email: AE }));
  const links = Object.fromEntries((sent.data.delivery?.links ?? []).map((l: { signerId: string; url: string }) => [l.signerId, l.url.split("/s/")[1]])) as Record<string, string>;
  return { doc, env: sent.data.envelope, links, ann: sent.data.envelope.signers[0], ben: sent.data.envelope.signers[1] };
}

/** Verify a signer with the code the debug delivery hands back. */
async function verify(w: SignWorld, token: string) {
  const code = (await json(await w.signer("POST", token, "/code"))).data.delivery.code as string;
  expect((await w.signer("POST", token, "/verify", { code })).status).toBe(200);
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120, 7)]).toString("base64");

describe("sending", () => {
  it("needs share on every document; freezes each at its version with its hash; links only to whoever's turn it is", async () => {
    const w = setup();
    const doc = await upload(w);
    expect((await w.request("POST", `${A}/envelopes`, { user: VERA, email: "vera@example.com", json: body(doc.id) })).status).toBe(404);
    expect((await w.request("POST", `${A}/envelopes`, { user: ALICE, email: AE, json: { ...body(doc.id), fields: body(doc.id).fields.slice(0, 2) } })).status).toBe(422); // Ben has no signature field
    expect((await w.request("POST", `${A}/envelopes`, { user: ALICE, email: AE, json: { ...body(doc.id), fields: [{ ...body(doc.id).fields[0], page: 9 }] } })).status).toBe(422);
    const { env, links } = await draftAndSend(w, "sequential");
    const content = new Uint8Array(await (await w.files.request("GET", `${A}/documents/${env.documents[0].documentId}/content`, { user: ALICE })).arrayBuffer());
    expect(env).toMatchObject({ status: "sent", orderMode: "sequential", documents: [{ version: 1, sha256: sha(content), pageCount: 2 }] });
    expect(env.signers.map((s: { email: string; status: string }) => [s.email, s.status])).toEqual([["ann@example.com", "notified"], ["ben@example.com", "pending"]]);
    expect(Object.keys(links)).toEqual([env.signers[0].id]); // sequential: only Ann so far
    expect(w.files.sent.filter((s) => s.body.templateKey === "sign.requested").map((s) => s.body.recipient.address)).toEqual(["ann@example.com"]);
    expect(w.files.sent.find((s) => s.body.templateKey === "sign.requested")!.body.templateData).toMatchObject({ from: AE, title: "Generated agreement" });
    expect((await w.request("POST", `${A}/envelopes/${env.id}/send`, { user: ALICE, email: AE })).status).toBe(409);
    expect((await w.request("PATCH", `${A}/envelopes/${env.id}`, { user: ALICE, email: AE, json: body(doc.id) })).status).toBe(409);
  });
});

describe("signing", () => {
  it("parallel: each verifies by email code, sees only their own fields and the document as sent, signs; the envelope completes", async () => {
    const w = setup();
    const { env, links, ann, ben, doc } = await draftAndSend(w);
    const annTok = links[ann.id]!;
    const benTok = links[ben.id]!;

    const s = (await json(await w.signer("GET", annTok))).data.session;
    expect(s).toMatchObject({ envelope: { title: "Generated agreement", from: AE }, signer: { email: "ann@example.com", verified: false }, yourTurn: true, others: [{ name: "Ben Example", status: "notified" }] });
    expect(s.fields.map((f: { kind: string }) => f.kind)).toEqual(["signature", "date"]);
    // The document only after verifying; codes: one per 30 s, a wrong one counts.
    expect((await w.signer("GET", annTok, `/documents/${doc.id}`)).status).toBe(403);
    const code = (await json(await w.signer("POST", annTok, "/code"))).data.delivery.code as string;
    expect((await w.signer("POST", annTok, "/code")).status).toBe(429);
    const wrong = await json(await w.signer("POST", annTok, "/verify", { code: code === "000000" ? "111111" : "000000" }));
    expect(wrong.error?.details?.attemptsLeft).toBe(4);
    expect((await w.signer("POST", annTok, "/verify", { code })).status).toBe(200);

    // Someone saves a new version meanwhile: the signer still gets the version that was sent.
    await w.files.request("POST", `${A}/documents/${doc.id}/versions`, { user: ALICE, body: fixturePdf(2, "changed"), headers: { "content-type": "application/pdf", "x-pagewell-base-version": "1" } });
    const asSent = new Uint8Array(await (await w.signer("GET", annTok, `/documents/${doc.id}`)).arrayBuffer());
    expect(sha(asSent)).toBe(env.documents[0].sha256);

    const annFields = s.fields as Array<{ id: string; kind: string }>;
    expect((await w.signer("POST", annTok, "/submit", { values: [{ fieldId: annFields[0]!.id, text: "Ann Example" }] })).status).toBe(422); // no consent
    expect((await w.signer("POST", annTok, "/submit", { consent: true, values: [] })).status).toBe(409); // a required field is empty
    const signed = await json(await w.signer("POST", annTok, "/submit", { consent: true, values: [{ fieldId: annFields[0]!.id, text: "Ann Example" }] }));
    expect(signed.data).toEqual({ signed: true, envelopeStatus: "sent" });
    expect((await w.signer("GET", annTok)).status).toBe(404); // the link is spent

    await verify(w, benTok);
    const benFields = (await json(await w.signer("GET", benTok))).data.session.fields as Array<{ id: string; kind: string }>;
    const done = await json(await w.signer("POST", benTok, "/submit", { consent: true, values: [{ fieldId: benFields[0]!.id, imagePng: PNG }, { fieldId: benFields[1]!.id, checked: true }] }));
    expect(done.data.envelopeStatus).toBe("completed");

    // The runner got the document as sent, the drawn signature, every value and the certificate.
    const call = w.runnerCalls[0]!;
    expect(call.header.operation).toBe("sign_complete");
    expect(sha(call.inputs[0]!)).toBe(env.documents[0].sha256);
    expect(call.images).toHaveLength(1);
    expect(call.header.options.fields.map((f: { kind: string; text?: string }) => [f.kind, f.text ?? null])).toEqual([["signature", "Ann Example"], ["date", "2026-11-01"], ["signature", null], ["checkbox", null]]);
    expect(call.header.options.certificate).toMatchObject({ envelopeId: env.id, signers: [{ name: "Ann Example", ip: "203.0.113.9" }, { name: "Ben Example" }], documents: [{ sha256: env.documents[0].sha256, version: 1 }] });

    // The sealed PDF is a document in Alice's drive; everyone gets its hash and a download link.
    const final = (await json(await w.request("GET", `${A}/envelopes/${env.id}`, { user: ALICE, email: AE }))).data.envelope;
    expect(final.status).toBe("completed");
    const sealed = new Uint8Array(await (await w.files.request("GET", `${A}/documents/${final.completedDocumentId}/content`, { user: ALICE })).arrayBuffer());
    expect(new TextDecoder().decode(sealed)).toContain("%pagewell-test-sealed");
    const completed = w.files.sent.filter((x) => x.body.templateKey === "sign.completed");
    expect(completed.map((x) => x.body.recipient.address).sort()).toEqual([AE, "ann@example.com", "ben@example.com"]);
    expect(completed[0]!.body.templateData).toMatchObject({ sha256: sha(sealed), downloadUrl: expect.stringMatching(/^https:\/\/editor\.example\.com\/l\//) });

    // The evidence log verifies, and tells the whole story.
    const ev = (await json(await w.request("GET", `${A}/envelopes/${env.id}/evidence`, { user: ALICE, email: AE }))).data;
    expect(ev.verdict).toMatchObject({ ok: true });
    expect(ev.events.map((e: { kind: string }) => e.kind)).toEqual([
      "envelope.created", "envelope.sent", "signer.notified", "signer.notified",
      "signer.viewed", "signer.code_sent", "signer.code_failed", "signer.verified", "signer.signed",
      "signer.code_sent", "signer.verified", "signer.viewed", "signer.signed",
      "envelope.all_signed", "envelope.completed",
    ]);
    expect(ev.events.find((e: { kind: string }) => e.kind === "envelope.completed").payload.sha256).toBe(sha(sealed));
  });

  it("sequential: the second signer waits their turn, then gets a link; the order is enforced", async () => {
    const w = setup();
    const { env, links, ann, ben } = await draftAndSend(w, "sequential");
    await verify(w, links[ann.id]!);
    const annFields = (await json(await w.signer("GET", links[ann.id]!))).data.session.fields;
    // Ben has no link yet; a resend reaches only whoever's turn it is (Ann).
    const resent = await json(await w.request("POST", `${A}/envelopes/${env.id}/resend`, { user: ALICE, email: AE }));
    expect(resent.data.delivery.links.map((l: { signerId: string }) => l.signerId)).toEqual([ann.id]);
    const annTok = resent.data.delivery.links[0].url.split("/s/")[1];
    expect((await w.signer("GET", links[ann.id]!)).status).toBe(404); // the resend replaced it
    await verify(w, annTok);
    await w.signer("POST", annTok, "/submit", { consent: true, values: [{ fieldId: annFields[0].id, text: "Ann" }] });
    expect(w.files.sent.filter((s) => s.body.templateKey === "sign.requested").map((s) => s.body.recipient.address)).toContain("ben@example.com");
    const benTok = (await json(await w.request("POST", `${A}/envelopes/${env.id}/resend`, { user: ALICE, email: AE }))).data.delivery.links[0].url.split("/s/")[1];
    const s = (await json(await w.signer("GET", benTok))).data.session;
    expect(s.yourTurn).toBe(true);
    await verify(w, benTok);
    const r = await json(await w.signer("POST", benTok, "/submit", { consent: true, values: [{ fieldId: s.fields[0].id, text: "Ben" }] }));
    expect(r.data.envelopeStatus).toBe("completed");
    void ben;
  });

  it("when the runner is away the envelope waits in completing; the hourly run finishes it", async () => {
    const w = setup();
    w.runnerDown = true;
    const { env, links, ann, ben } = await draftAndSend(w);
    for (const [s, fieldKind] of [[ann, "signature"], [ben, "signature"]] as const) {
      const tok = links[s.id]!;
      await verify(w, tok);
      const f = (await json(await w.signer("GET", tok))).data.session.fields.find((x: { kind: string }) => x.kind === fieldKind);
      await w.signer("POST", tok, "/submit", { consent: true, values: [{ fieldId: f.id, text: s.name }] });
    }
    expect((await json(await w.request("GET", `${A}/envelopes/${env.id}`, { user: ALICE, email: AE }))).data.envelope.status).toBe("completing");
    expect(await w.housekeeping()).toMatchObject({ completed: 0 }); // too soon, and still down
    w.runnerDown = false;
    w.advance(6 * 60_000);
    expect(await w.housekeeping()).toMatchObject({ completed: 1 });
    expect((await json(await w.request("GET", `${A}/envelopes/${env.id}`, { user: ALICE, email: AE }))).data.envelope.status).toBe("completed");
  });
});

describe("ending early", () => {
  it("a decline closes the envelope, tells the sender, and kills every link; a void tells the signers", async () => {
    const w = setup();
    const a = await draftAndSend(w);
    expect((await w.signer("POST", a.links[a.ben.id]!, "/decline", { reason: "Wrong amount" })).status).toBe(200);
    expect(w.files.sent.find((s) => s.body.templateKey === "sign.declined")).toMatchObject({ body: { recipient: { address: AE }, templateData: { reason: "Wrong amount", signerEmail: "ben@example.com" } } });
    expect((await w.signer("GET", a.links[a.ann.id]!)).status).toBe(404);
    expect((await json(await w.request("GET", `${A}/envelopes/${a.env.id}`, { user: ALICE, email: AE }))).data.envelope.status).toBe("declined");

    const b = await draftAndSend(w);
    expect((await json(await w.request("POST", `${A}/envelopes/${b.env.id}/void`, { user: ALICE, email: AE, json: { reason: "Sent by mistake" } }))).data.envelope.status).toBe("voided");
    expect(w.files.sent.filter((s) => s.body.templateKey === "sign.voided").map((s) => s.body.recipient.address).sort()).toEqual(["ann@example.com", "ben@example.com"]);
    expect((await w.signer("GET", b.links[b.ann.id]!)).status).toBe(404);
  });

  it("the hourly run expires envelopes and sends reminders with fresh links", async () => {
    const w = setup();
    const r = await draftAndSend(w, "parallel", { reminderDays: 2 });
    w.advance(2 * DAY + 60_000);
    expect(await w.housekeeping()).toMatchObject({ reminded: 2 });
    expect(w.files.sent.filter((s) => s.body.templateKey === "sign.reminder")).toHaveLength(2);
    expect((await w.signer("GET", r.links[r.ann.id]!)).status).toBe(404); // the reminder's link replaced it
    const e = await draftAndSend(w, "parallel", { expiresAt: new Date(w.files.now.getTime() + 2 * DAY).toISOString() });
    w.advance(3 * DAY);
    expect((await w.housekeeping()).expired).toBeGreaterThanOrEqual(1);
    expect((await json(await w.request("GET", `${A}/envelopes/${e.env.id}`, { user: ALICE, email: AE }))).data.envelope.status).toBe("expired");
  });
});

describe("isolation", () => {
  it("another org sees and changes nothing; a viewer cannot manage; a stranger's guess at a link is a 404", async () => {
    const w = setup();
    const { env } = await draftAndSend(w);
    for (const [method, path] of [["GET", `${B}/envelopes/${env.id}`], ["POST", `${B}/envelopes/${env.id}/void`], ["POST", `${B}/envelopes/${env.id}/resend`], ["GET", `${B}/envelopes/${env.id}/evidence`], ["GET", `${A}/envelopes/${env.id}`]] as const) {
      const r = await w.request(method, path, { user: BOB, email: "bob@example.com" });
      expect({ path, status: r.status }).toEqual({ path, status: 404 });
    }
    expect((await w.request("POST", `${A}/envelopes/${env.id}/void`, { user: VERA, email: "vera@example.com" })).status).toBe(404);
    expect((await json(await w.request("GET", `${B}/envelopes`, { user: BOB, email: "bob@example.com" }))).data.envelopes).toEqual([]);
    expect((await w.signer("GET", "x".repeat(43))).status).toBe(404);
    expect((await json(await w.request("GET", `${A}/envelopes/${env.id}`, { user: ALICE, email: AE }))).data.envelope.status).toBe("sent");
  });
});

// With a real pdf-runner (RUNNER_URL, holding a test signing ID): a whole envelope sealed for
// real. SEALED_OUT keeps the file for pdfsig. Skipped otherwise (the runner image's own tests
// cover sign_complete in CI).
(process.env.RUNNER_URL ? describe : describe.skip)("with the real runner", () => {
  it("two signers, one drawn signature: a PAdES-sealed PDF with a certificate page lands in the drive", async () => {
    const { writeFileSync } = await import("node:fs");
    const { signaturePng } = await import("../../../containers/pdf-runner/test/fixtures.mjs" as string);
    const w = setup();
    const { env, links, ann, ben } = await draftAndSend(w);
    for (const s of [ann, ben]) {
      const tok = links[s.id]!;
      await verify(w, tok);
      const f = (await json(await w.signer("GET", tok))).data.session.fields.find((x: { kind: string }) => x.kind === "signature");
      const value = s === ben ? { fieldId: f.id, imagePng: (await signaturePng()).toString("base64") } : { fieldId: f.id, text: s.name };
      await w.signer("POST", tok, "/submit", { consent: true, values: [value] });
    }
    const final = (await json(await w.request("GET", `${A}/envelopes/${env.id}`, { user: ALICE, email: AE }))).data.envelope;
    expect(final.status).toBe("completed");
    const sealed = new Uint8Array(await (await w.files.request("GET", `${A}/documents/${final.completedDocumentId}/content`, { user: ALICE })).arrayBuffer());
    expect(sha(sealed)).toBe(sha(w.realSealed!));
    expect(new TextDecoder("latin1").decode(sealed)).toContain("ETSI.CAdES.detached");
    if (process.env.SEALED_OUT) writeFileSync(process.env.SEALED_OUT, sealed);
  }, 120_000);
});
