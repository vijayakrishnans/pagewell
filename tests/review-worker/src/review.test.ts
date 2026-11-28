import { toPublic } from "@review-worker/ids";
import { remind } from "@review-worker/cron";
import { fixturePdf, reviewWorld, type ReviewWorld } from "./harness.js";

// Review (PW5) through review-worker's router, against the real files-worker: who may comment,
// replies and statuses, anchors carried or outdated across versions, mentions, review requests
// and reminders, the DocRoom (tickets, presence, the edit lease, live fan-out), and isolation.

const ORG_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const ORG_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const A = `/v1/organizations/${toPublic("org", ORG_A)}`;
const B = `/v1/organizations/${toPublic("org", ORG_B)}`;
const ALICE = "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; // owner of A
const VERA = "usr_cccccccccccccccccccccccccccccccc"; // viewer of A
const BOB = "usr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"; // owner of B
const GUEST = "usr_99999999999999999999999999999999";
const AE = "alice@example.com";
const GE = "guest@example.com";

type Json = { data: Record<string, any>; error?: { code: string } }; // eslint-disable-line @typescript-eslint/no-explicit-any
const json = async (r: Response) => (await r.json()) as Json;

function setup(): ReviewWorld {
  const w = reviewWorld();
  w.files.directory.add(ALICE, ORG_A, "owner");
  w.files.directory.add(VERA, ORG_A, "viewer");
  w.files.directory.add(BOB, ORG_B, "owner");
  return w;
}

async function upload(w: ReviewWorld, pages = 3) {
  const r = await w.files.request("POST", `${A}/documents?name=Reviewed.pdf`, { user: ALICE, body: fixturePdf(pages), headers: { "content-type": "application/pdf", "x-pagewell-page-count": String(pages) } });
  return (await json(r)).data.document as { id: string };
}
const putText = (w: ReviewWorld, doc: string, v: number, pages: Record<number, string>) =>
  w.files.request("PUT", `${A}/documents/${doc}/versions/${v}/text`, { user: ALICE, body: JSON.stringify({ pages: Object.entries(pages).map(([p, text]) => ({ page: Number(p), text })) }), headers: { "content-type": "application/json" } });
const saveV = (w: ReviewWorld, doc: string, base: number) =>
  w.files.request("POST", `${A}/documents/${doc}/versions`, { user: ALICE, body: fixturePdf(3, `v${base + 1}`), headers: { "content-type": "application/pdf", "x-pagewell-base-version": String(base) } });
const anchor = (page = 2, quote: string | null = "payment terms") => ({ page, rect: [72, 100, 200, 20], quote });
const start = (w: ReviewWorld, doc: string, body: string, user = ALICE, email = AE, a = anchor()) => w.request("POST", `${A}/documents/${doc}/threads`, { user, email, json: { anchor: a, body } });
const auditTypes = (w: ReviewWorld) => (w.files.db.prepare(`SELECT event_type FROM events_audit_entries WHERE source = 'review-worker' ORDER BY rowid`).all() as Array<{ event_type: string }>).map((r) => r.event_type);

describe("threads and comments", () => {
  it("an owner comments; a viewer reads but cannot; a guest commenter can; strangers get 404", async () => {
    const w = setup();
    const doc = await upload(w);
    const res = await start(w, doc.id, "Check the payment terms.");
    expect(res.status).toBe(201);
    const t = (await json(res)).data.thread;
    expect(t).toMatchObject({ documentId: doc.id, version: 1, status: "open", anchor: anchor(), comments: [{ body: "Check the payment terms.", author: { kind: "member", id: ALICE, name: AE } }] });
    expect((await json(await w.request("GET", `${A}/documents/${doc.id}/threads`, { user: VERA }))).data.threads).toHaveLength(1);
    expect((await start(w, doc.id, "Viewer here", VERA, "vera@example.com")).status).toBe(404);
    await w.files.request("POST", `${A}/documents/${doc.id}/grants`, { user: ALICE, json: { email: GE, role: "commenter", notify: false } });
    const g = await start(w, doc.id, "Guest note", GUEST, GE);
    expect(g.status).toBe(201);
    expect((await json(g)).data.thread.comments[0].author.kind).toBe("guest");
    expect((await w.request("GET", `${A}/documents/${doc.id}/threads`, { user: BOB })).status).toBe(404);
    expect((await start(w, doc.id, "x", ALICE, AE, { page: 9, rect: [0, 0, 1, 1], quote: null })).status).toBe(422);
    expect((await start(w, doc.id, "", ALICE)).status).toBe(422);
    expect((await w.request("GET", `${A}/documents/${doc.id}/threads`)).status).toBe(401);
  });

  it("replies, resolves and reopens; only authors edit; editors may delete anyone's comment", async () => {
    const w = setup();
    const doc = await upload(w);
    await w.files.request("POST", `${A}/documents/${doc.id}/grants`, { user: ALICE, json: { email: GE, role: "commenter", notify: false } });
    const t = (await json(await start(w, doc.id, "First"))).data.thread;
    const r = await w.request("POST", `${A}/threads/${t.id}/comments`, { user: GUEST, email: GE, json: { body: "Guest reply" } });
    expect(r.status).toBe(201);
    const reply = (await json(r)).data.comment;
    expect((await w.request("PATCH", `${A}/threads/${t.id}/comments/${reply.id}`, { user: ALICE, email: AE, json: { body: "Alice rewrites" } })).status).toBe(404);
    expect((await json(await w.request("PATCH", `${A}/threads/${t.id}/comments/${reply.id}`, { user: GUEST, email: GE, json: { body: "Guest edits" } }))).data.comment.body).toBe("Guest edits");
    expect((await w.request("DELETE", `${A}/threads/${t.id}/comments/${t.comments[0].id}`, { user: GUEST, email: GE })).status).toBe(404);
    expect((await w.request("DELETE", `${A}/threads/${t.id}/comments/${reply.id}`, { user: ALICE, email: AE })).status).toBe(204);
    expect((await json(await w.request("PATCH", `${A}/threads/${t.id}`, { user: GUEST, email: GE, json: { status: "resolved" } }))).data.thread.status).toBe("resolved");
    expect((await json(await w.request("PATCH", `${A}/threads/${t.id}`, { user: ALICE, email: AE, json: { status: "open" } }))).data.thread.status).toBe("open");
    const listed = (await json(await w.request("GET", `${A}/documents/${doc.id}/threads`, { user: ALICE }))).data.threads[0];
    expect(listed.comments.map((c: { body: string; deleted: boolean }) => [c.body, c.deleted])).toEqual([["First", false], ["", true]]);
    expect(auditTypes(w)).toEqual(["thread.created", "comment.created", "comment.edited", "comment.deleted", "thread.resolved", "thread.reopened"]);
  });
});

describe("anchors across versions", () => {
  it("listing carries each thread to the current version, or marks it outdated (never moved)", async () => {
    const w = setup();
    const doc = await upload(w);
    await putText(w, doc.id, 1, { 1: "Cover", 2: "The payment terms are thirty days. Delivery in March.", 3: "Signatures" });
    const kept = (await json(await start(w, doc.id, "On terms", ALICE, AE, anchor(2, "payment terms")))).data.thread;
    const gone = (await json(await start(w, doc.id, "On delivery", ALICE, AE, anchor(2, "Delivery in March")))).data.thread;
    const pinned = (await json(await start(w, doc.id, "Cover pin", ALICE, AE, anchor(1, null)))).data.thread;
    const last = (await json(await start(w, doc.id, "Signature page", ALICE, AE, anchor(3, null)))).data.thread;
    expect((await saveV(w, doc.id, 1)).status).toBe(201);
    await putText(w, doc.id, 2, { 1: "Cover", 2: "The payment terms are sixty days.", 3: "Signatures changed" });
    const threads = (await json(await w.request("GET", `${A}/documents/${doc.id}/threads`, { user: ALICE }))).data.threads;
    const by = (id: string) => threads.find((t: { id: string }) => t.id === id);
    expect(by(kept.id)).toMatchObject({ version: 2, status: "open", anchor: { page: 2 } });
    expect(by(gone.id)).toMatchObject({ version: 2, status: "outdated", anchor: { page: 2 } });
    expect(by(pinned.id)).toMatchObject({ version: 2, status: "open" });
    expect(by(last.id)).toMatchObject({ version: 2, status: "outdated" });
    // An outdated thread keeps its comments and cannot be resolved.
    expect(by(gone.id).comments[0].body).toBe("On delivery");
    expect((await w.request("PATCH", `${A}/threads/${gone.id}`, { user: ALICE, email: AE, json: { status: "resolved" } })).status).toBe(409);
  });
});

describe("mentions", () => {
  it("email only people already in the conversation", async () => {
    const w = setup();
    const doc = await upload(w);
    await w.files.request("POST", `${A}/documents/${doc.id}/grants`, { user: ALICE, json: { email: GE, role: "commenter", notify: false } });
    const t = (await json(await start(w, doc.id, "Opening note"))).data.thread;
    await w.request("POST", `${A}/threads/${t.id}/comments`, { user: GUEST, email: GE, json: { body: "Guest was here" } });
    w.files.sent.length = 0;
    await w.request("POST", `${A}/threads/${t.id}/comments`, { user: ALICE, email: AE, json: { body: "Thanks @guest@example.com, and @stranger@example.com and @alice@example.com" } });
    expect(w.files.sent.map((s) => [s.body.templateKey, s.body.recipient.address])).toEqual([["review.mentioned", GE]]);
    expect(w.files.sent[0]!.body.templateData).toMatchObject({ documentName: "Reviewed.pdf", page: 2, by: AE });
  });
});

describe("review requests", () => {
  it("share the document with each reviewer, email them, and close when everyone decided", async () => {
    const w = setup();
    const doc = await upload(w);
    const due = new Date(w.files.now.getTime() + 2 * 86_400_000).toISOString();
    const res = await w.request("POST", `${A}/documents/${doc.id}/review-requests`, { user: ALICE, email: AE, json: { reviewers: ["Guest@Example.com", "carol@example.com"], message: "Please look", dueAt: due } });
    expect(res.status).toBe(201);
    const req = (await json(res)).data.request;
    expect(req).toMatchObject({ status: "open", version: 1, dueAt: due, reviewers: [{ email: "carol@example.com", decision: null }, { email: GE, decision: null }] });
    const sent = w.files.sent.map((s) => [s.body.templateKey, s.body.recipient.address]);
    expect(sent).toEqual(expect.arrayContaining([["files.shared", GE], ["files.shared", "carol@example.com"], ["review.requested", GE], ["review.requested", "carol@example.com"]]));
    // The guest can now comment, and decide.
    expect((await start(w, doc.id, "Reviewer note", GUEST, GE)).status).toBe(201);
    expect((await w.request("POST", `${A}/review-requests/${req.id}/decision`, { user: VERA, email: "vera@example.com", json: { decision: "approved" } })).status).toBe(404);
    expect((await json(await w.request("POST", `${A}/review-requests/${req.id}/decision`, { user: GUEST, email: GE, json: { decision: "approved" } }))).data.request.status).toBe("open");
    // Only someone who may share asks for a review.
    expect((await w.request("POST", `${A}/documents/${doc.id}/review-requests`, { user: GUEST, email: GE, json: { reviewers: ["x@example.com"] } })).status).toBe(404);
    expect((await w.request("POST", `${A}/documents/${doc.id}/review-requests`, { user: ALICE, email: AE, json: { reviewers: ["not an email"] } })).status).toBe(422);

    // Reminders: due within a day, once a day, only to those who have not decided.
    w.files.sent.length = 0;
    const soon = new Date(w.files.now.getTime() + 1.5 * 86_400_000);
    expect(await remind(w.env, soon)).toEqual({ requests: 1, emails: 1 });
    expect(w.files.sent.map((s) => [s.body.templateKey, s.body.recipient.address])).toEqual([["review.reminder", "carol@example.com"]]);
    expect(await remind(w.env, new Date(soon.getTime() + 3_600_000))).toEqual({ requests: 0, emails: 0 });
    // The creator cancels; nothing more to remind.
    expect((await w.request("DELETE", `${A}/review-requests/${req.id}`, { user: ALICE, email: AE })).status).toBe(204);
    expect(await remind(w.env, new Date(soon.getTime() + 2 * 86_400_000))).toEqual({ requests: 0, emails: 0 });
    expect(auditTypes(w)).toEqual(expect.arrayContaining(["review_request.created", "review_request.decided", "review_request.canceled"]));
  });
});

describe("the DocRoom", () => {
  async function ticket(w: ReviewWorld, doc: string, user: string, email: string) {
    const r = await w.request("POST", `${A}/documents/${doc}/room/ticket`, { user, email });
    return { status: r.status, body: r.status === 201 ? (await json(r)).data : null };
  }

  it("needs read access for a ticket; a ticket admits once, and not after a minute", async () => {
    const w = setup();
    const doc = await upload(w);
    expect((await ticket(w, doc.id, BOB, "bob@example.com")).status).toBe(404);
    const t = await ticket(w, doc.id, VERA, "vera@example.com");
    expect(t.body).toMatchObject({ canEdit: false, canBreak: false });
    expect(await w.connect(ORG_A, doc.id.replace("doc_", ""), "nonsense")).toBeNull();
    const docUuid = (await import("@review-worker/ids")).fromPublic("doc", doc.id)!;
    expect(await w.connect(ORG_A, docUuid, t.body!.ticket)).not.toBeNull();
    expect(await w.connect(ORG_A, docUuid, t.body!.ticket)).toBeNull();
    const late = await ticket(w, doc.id, VERA, "vera@example.com");
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    try {
      expect(await w.connect(ORG_A, docUuid, late.body!.ticket)).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });

  it("shows who is here; one editor holds the lease; a viewer cannot; leaving or breaking frees it", async () => {
    const w = setup();
    const ADMIN = "usr_dddddddddddddddddddddddddddddddd";
    const BUILDER = "usr_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    w.files.directory.add(ADMIN, ORG_A, "admin");
    w.files.directory.add(BUILDER, ORG_A, "builder");
    const doc = await upload(w);
    const docUuid = (await import("@review-worker/ids")).fromPublic("doc", doc.id)!;
    const join = async (user: string, email: string) => (await w.connect(ORG_A, docUuid, (await ticket(w, doc.id, user, email)).body!.ticket))!;
    const alice = await join(ALICE, AE);
    const vera = await join(VERA, "vera@example.com");
    const builder = await join(BUILDER, "builder@example.com");
    const { room } = w.room(ORG_A, docUuid);
    expect(alice.socket.last("presence")!.people.map((p: { id: string }) => p.id).sort()).toEqual([ALICE, BUILDER, VERA].sort());

    await room.webSocketMessage(vera.socket as unknown as WebSocket, JSON.stringify({ type: "lease.take" }));
    expect(vera.socket.last("lease")!.holder).toBeNull();
    await room.webSocketMessage(alice.socket as unknown as WebSocket, JSON.stringify({ type: "lease.take" }));
    expect(builder.socket.last("lease")!.holder).toEqual({ id: ALICE, name: AE });
    // Each connection is told whether the lease is its own.
    expect([alice.socket.last("lease")!.mine, builder.socket.last("lease")!.mine]).toEqual([true, false]);
    await room.webSocketMessage(builder.socket as unknown as WebSocket, JSON.stringify({ type: "lease.take" }));
    expect(builder.socket.last("lease")!.holder.id).toBe(ALICE);
    expect(vera.socket.last("presence")!.people.find((p: { id: string }) => p.id === ALICE).editing).toBe(true);

    // The holder's save tells everyone else; nobody else can announce one.
    await room.webSocketMessage(builder.socket as unknown as WebSocket, JSON.stringify({ type: "version", version: 9 }));
    expect(vera.socket.last("version")).toBeUndefined();
    await room.webSocketMessage(alice.socket as unknown as WebSocket, JSON.stringify({ type: "version", version: 2 }));
    expect(vera.socket.last("version")).toEqual({ type: "version", version: 2, by: AE });
    expect(alice.socket.last("version")).toBeUndefined();

    // Leaving frees the lease; the builder takes it; an admin (may share) breaks it.
    await room.webSocketClose(alice.socket as unknown as WebSocket);
    expect(vera.socket.last("lease")!.holder).toBeNull();
    await room.webSocketMessage(builder.socket as unknown as WebSocket, JSON.stringify({ type: "lease.take" }));
    expect(vera.socket.last("lease")!.holder.id).toBe(BUILDER);
    await room.webSocketMessage(vera.socket as unknown as WebSocket, JSON.stringify({ type: "lease.break" }));
    expect(vera.socket.last("lease")!.holder.id).toBe(BUILDER);
    const admin = await join(ADMIN, "admin@example.com");
    await room.webSocketMessage(admin.socket as unknown as WebSocket, JSON.stringify({ type: "lease.break" }));
    expect(vera.socket.last("lease")!.holder).toBeNull();

    // A lease nobody renews ends with its alarm.
    await room.webSocketMessage(builder.socket as unknown as WebSocket, JSON.stringify({ type: "lease.take" }));
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    try {
      await room.alarm();
    } finally {
      Date.now = realNow;
    }
    expect(vera.socket.last("lease")!.holder).toBeNull();
  });

  it("fans out a new comment to everyone in the room, live", async () => {
    const w = setup();
    const doc = await upload(w);
    const docUuid = (await import("@review-worker/ids")).fromPublic("doc", doc.id)!;
    const one = (await w.connect(ORG_A, docUuid, (await ticket(w, doc.id, ALICE, AE)).body!.ticket))!;
    const two = (await w.connect(ORG_A, docUuid, (await ticket(w, doc.id, VERA, "vera@example.com")).body!.ticket))!;
    const t = (await json(await start(w, doc.id, "Live comment"))).data.thread;
    expect(one.socket.last("thread")!.thread).toMatchObject({ id: t.id, comments: [{ body: "Live comment" }] });
    expect(two.socket.last("thread")!.thread.id).toBe(t.id);
    await w.request("POST", `${A}/threads/${t.id}/comments`, { user: ALICE, email: AE, json: { body: "A reply" } });
    expect(two.socket.last("thread")!.thread.comments.map((c: { body: string }) => c.body)).toEqual(["Live comment", "A reply"]);
  });
});

describe("isolation", () => {
  it("another org's threads, comments and requests answer 404 and change nothing", async () => {
    const w = setup();
    const doc = await upload(w);
    const t = (await json(await start(w, doc.id, "A's"))).data.thread;
    const req = (await json(await w.request("POST", `${A}/documents/${doc.id}/review-requests`, { user: ALICE, email: AE, json: { reviewers: ["x@example.com"] } }))).data.request;
    const before = JSON.stringify(["review_threads", "review_comments", "review_requests"].map((x) => w.files.db.prepare(`SELECT * FROM ${x} ORDER BY 1`).all()));
    for (const [method, path, body] of [
      ["GET", `${B}/documents/${doc.id}/threads`],
      ["POST", `${B}/documents/${doc.id}/threads`, { anchor: anchor(), body: "x" }],
      ["POST", `${B}/threads/${t.id}/comments`, { body: "x" }],
      ["POST", `${A}/threads/${t.id}/comments`, { body: "x" }],
      ["PATCH", `${B}/threads/${t.id}`, { status: "resolved" }],
      ["DELETE", `${B}/threads/${t.id}/comments/${t.comments[0].id}`],
      ["GET", `${B}/documents/${doc.id}/review-requests`],
      ["DELETE", `${B}/review-requests/${req.id}`],
      ["POST", `${B}/documents/${doc.id}/room/ticket`],
    ] as Array<[string, string, unknown?]>) {
      const r = await w.request(method, path, { user: BOB, email: "bob@example.com", ...(body ? { json: body } : {}) });
      expect({ method, path, status: r.status }).toEqual({ method, path, status: 404 });
    }
    expect(JSON.stringify(["review_threads", "review_comments", "review_requests"].map((x) => w.files.db.prepare(`SELECT * FROM ${x} ORDER BY 1`).all()))).toBe(before);
  });
});
