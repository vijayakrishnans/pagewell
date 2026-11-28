import { COMMENT_MAX_CHARS, type PublicAnchor, type RoomEvent } from "@saas/contracts/review";
import type { PublicAccess } from "@saas/contracts/sharing";
import { createSqlExecutor } from "@saas/db/d1";
import { createEventsRepository } from "@saas/db/events";
import { createReviewRepository, type ReviewRepository, type Thread } from "@saas/db/review";
import type { Uuid } from "@saas/db/ids";
import { carryAnchor, versionText } from "@saas/shared/anchors";
import { audit } from "./audit.js";
import { DriveError, driveFor, type Actor, type Drive } from "./drive.js";
import type { Env } from "./env.js";
import { fail, invalid, methodNotAllowed, notFound, ok, readJson, unavailable } from "./http.js";
import { fromPublic, generateRequestId, newUuid, orderedUuid, toPublic } from "./ids.js";
import { mentionsIn, notify } from "./notify.js";
import { publicComment, publicRequest, publicThread } from "./public.js";
import { roomFor } from "./room.js";

// Review (PW5), behind api-edge (which authenticates and sets the actor headers), under
// /v1/organizations/{org}/. What a person may do is what the drive says they may do on the
// document, asked of files-worker as that person: read to see threads and requests, comment to
// write and resolve, write to remove another's comment, share to request a review or break an
// edit lease. Every miss is the same 404.
//
//   GET|POST /documents/{doc}/threads           list (anchors carried to the current version) | start
//   POST     /threads/{thr}/comments            reply
//   PATCH    /threads/{thr}                     {status: open|resolved}
//   PATCH|DELETE /threads/{thr}/comments/{cmt}  edit (author) | delete (author, or an editor)
//   GET|POST /documents/{doc}/review-requests   list | ask people (shares the document with them)
//   POST     /review-requests/{rvr}/decision    {decision} by a named reviewer
//   DELETE   /review-requests/{rvr}             cancel (its creator, or someone who may share)
//   POST     /documents/{doc}/room/ticket       a single-use ticket for the DocRoom WebSocket
//   GET      /documents/{doc}/room?ticket=      the DocRoom WebSocket (no session: the ticket is the key)

const REQUEST_ID = /^[\w-]{1,128}$/;
const ORG_ROUTE = /^\/v1\/organizations\/([^/]+)(\/.*)$/;
const EMAIL = /^[^\s@]{1,200}@[^\s@]{1,200}\.[^\s@]{1,63}$/;

interface Ctx {
  env: Env;
  requestId: string;
  actor: Actor;
  orgId: Uuid;
  orgPublic: string;
  repo: ReviewRepository;
  drive: Drive;
  events: ReturnType<typeof createEventsRepository>;
  now: Date;
}

function resolveActor(request: Request): Actor | null {
  const subjectId = request.headers.get("x-actor-subject-id");
  const subjectType = request.headers.get("x-actor-subject-type");
  if (!subjectId || !subjectType) return null;
  const email = request.headers.get("x-actor-email")?.trim().toLowerCase() ?? "";
  return { subjectId, subjectType, email: subjectType === "user" && EMAIL.test(email) ? email : null };
}

const auditCtx = (ctx: Ctx) => ({ orgId: ctx.orgId, actor: { type: ctx.actor.subjectType, id: ctx.actor.subjectId }, requestId: ctx.requestId, now: ctx.now });

/** What the caller may do on the document (null: nothing, or not found). */
async function accessTo(ctx: Ctx, docUuid: string): Promise<PublicAccess | null> {
  return ctx.drive.access("document", toPublic("doc", docUuid));
}
const can = (a: PublicAccess | null, action: string) => Boolean(a?.actions.includes(action as never));

function authorOf(ctx: Ctx, access: PublicAccess) {
  return {
    authorKind: ctx.actor.subjectType === "user" ? (access.principal === "guest" ? ("guest" as const) : ("member" as const)) : ("agent" as const),
    authorId: ctx.actor.subjectId,
    authorName: ctx.actor.email,
  };
}

function cleanBody(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/\r\n/g, "\n").trim();
  return s.length >= 1 && s.length <= COMMENT_MAX_CHARS && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s) ? s : null;
}

function cleanAnchor(v: unknown): PublicAnchor | null {
  const a = v as Partial<PublicAnchor> | null;
  if (!a || typeof a !== "object") return null;
  const page = a.page;
  const rect = a.rect;
  if (!Number.isInteger(page) || (page as number) < 1 || (page as number) > 100_000) return null;
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every((n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) < 1_000_000)) return null;
  const quote = typeof a.quote === "string" && a.quote.trim() ? a.quote.trim().slice(0, 500) : null;
  return { page: page as number, rect: rect as [number, number, number, number], quote };
}

async function broadcast(ctx: Ctx, docUuid: string, event: RoomEvent) {
  const room = roomFor(ctx.env, ctx.orgId, docUuid);
  if (!room) return;
  try {
    await room.fetch("https://room/broadcast", { method: "POST", body: JSON.stringify(event) });
  } catch {
    /* nobody is in the room, or it is busy: they get it on their next load */
  }
}

/** Carry every thread made on an older version to the current one (once), then list them. */
async function carried(ctx: Ctx, docUuid: string, current: number, pageCount: number | null, threads: Thread[]): Promise<Thread[]> {
  const behind = threads.filter((t) => t.version < current && t.status !== "outdated");
  if (behind.length === 0) return threads;
  const texts = new Map<number, unknown>();
  const textOf = async (v: number) => {
    if (!texts.has(v)) texts.set(v, await ctx.drive.text(toPublic("doc", docUuid), v));
    return texts.get(v);
  };
  const to = versionText(await textOf(current), pageCount);
  const out = new Map(threads.map((t) => [t.id, t]));
  for (const t of behind) {
    const from = versionText(await textOf(t.version), null);
    const outcome = carryAnchor(t.anchor, from, to);
    const r = await ctx.repo.carry(ctx.orgId, t.id as Uuid, t.version, current, { status: outcome.status === "outdated" ? "outdated" : t.status, anchor: outcome.anchor }, ctx.now);
    if (r.ok) out.set(t.id, r.value);
  }
  return [...out.values()];
}

async function listThreads(ctx: Ctx, docUuid: Uuid): Promise<Response> {
  const doc = await ctx.drive.document(toPublic("doc", docUuid));
  if (doc.deletedAt) return notFound(ctx.requestId);
  const r = await ctx.repo.listThreads(ctx.orgId, docUuid);
  if (!r.ok) return unavailable(ctx.requestId);
  const threads = await carried(ctx, docUuid, doc.currentVersion, doc.pageCount, r.value);
  return ok({ threads: threads.map(publicThread) }, ctx.requestId);
}

async function startThread(ctx: Ctx, request: Request, docUuid: Uuid): Promise<Response> {
  const body = await readJson(request);
  const anchor = cleanAnchor(body?.anchor);
  const text = cleanBody(body?.body);
  if (!anchor || !text) return invalid(ctx.requestId, { ...(anchor ? {} : { anchor: ["{page, rect: [x, y, w, h], quote?}"] }), ...(text ? {} : { body: [`1–${COMMENT_MAX_CHARS} characters`] }) });
  const access = await accessTo(ctx, docUuid);
  if (!can(access, "files.comment")) return notFound(ctx.requestId);
  const doc = await ctx.drive.document(toPublic("doc", docUuid));
  if (doc.deletedAt) return notFound(ctx.requestId);
  const version = Number.isInteger(body?.version) && (body!.version as number) >= 1 && (body!.version as number) <= doc.currentVersion ? (body!.version as number) : doc.currentVersion;
  if (doc.pageCount && anchor.page > doc.pageCount) return invalid(ctx.requestId, { anchor: [`page 1 to ${doc.pageCount}`] });
  const mentions = mentionsIn(text);
  const r = await ctx.repo.createThread({ id: orderedUuid(ctx.now), orgId: ctx.orgId, docId: docUuid, anchor, version, comment: { id: orderedUuid(ctx.now), ...authorOf(ctx, access!), body: text, mentions }, now: ctx.now });
  if (!r.ok) return unavailable(ctx.requestId);
  await audit(ctx.events, auditCtx(ctx), docUuid, "thread.created", `Commented on page ${anchor.page} of "${doc.name}"`, { threadId: toPublic("thr", r.value.id), page: anchor.page, version });
  await notifyMentions(ctx, docUuid, doc.name, r.value, mentions, text);
  await broadcast(ctx, docUuid, { type: "thread", thread: publicThread(r.value) });
  return ok({ thread: publicThread(r.value) }, ctx.requestId, 201);
}

/**
 * Email the people a comment mentions, but only those already in the conversation (comment
 * authors on this document, or reviewers of an open request on it): a mention never tells a
 * stranger a document's name or a comment's text.
 */
async function notifyMentions(ctx: Ctx, docUuid: Uuid, docName: string, thread: Thread, mentions: string[], text: string) {
  if (mentions.length === 0) return;
  const [threads, requests] = await Promise.all([ctx.repo.listThreads(ctx.orgId, docUuid), ctx.repo.listRequests(ctx.orgId, docUuid)]);
  const known = new Set<string>();
  for (const t of threads.ok ? threads.value : []) for (const c of t.comments) if (c.authorName) known.add(c.authorName.toLowerCase());
  for (const r of requests.ok ? requests.value : []) if (r.status === "open") for (const v of r.reviewers) known.add(v.email);
  const openUrl = ctx.env.EDITOR_URL && /^https:\/\/[^\s/]+$/.test(ctx.env.EDITOR_URL) ? `${ctx.env.EDITOR_URL}/edit/${toPublic("doc", docUuid)}?org=${ctx.orgPublic}` : null;
  for (const email of mentions) {
    if (email === ctx.actor.email || !known.has(email)) continue;
    await notify(ctx.env, auditCtx(ctx), "review.mentioned", email, { documentName: docName, page: thread.anchor.page, excerpt: text.slice(0, 200), by: ctx.actor.email, openUrl }, [toPublic("thr", thread.id), email.replace(/[^A-Za-z0-9._-]/g, "_"), String(thread.comments.length)]);
  }
}

async function threadAnd(ctx: Ctx, threadId: Uuid, action: string): Promise<{ thread: Thread; access: PublicAccess } | null> {
  const t = await ctx.repo.getThread(ctx.orgId, threadId);
  if (!t.ok) return null;
  const access = await accessTo(ctx, t.value.docId);
  return can(access, action) ? { thread: t.value, access: access! } : null;
}

async function reply(ctx: Ctx, request: Request, threadId: Uuid): Promise<Response> {
  const body = await readJson(request);
  const text = cleanBody(body?.body);
  if (!text) return invalid(ctx.requestId, { body: [`1–${COMMENT_MAX_CHARS} characters`] });
  const found = await threadAnd(ctx, threadId, "files.comment");
  if (!found) return notFound(ctx.requestId);
  const mentions = mentionsIn(text);
  const c = await ctx.repo.addComment(ctx.orgId, threadId, { id: orderedUuid(ctx.now), ...authorOf(ctx, found.access), body: text, mentions }, ctx.now);
  if (!c.ok) return c.error.kind === "not_found" ? notFound(ctx.requestId) : unavailable(ctx.requestId);
  const updated = await ctx.repo.getThread(ctx.orgId, threadId);
  const doc = await ctx.drive.document(toPublic("doc", found.thread.docId));
  await audit(ctx.events, auditCtx(ctx), found.thread.docId, "comment.created", `Replied on page ${found.thread.anchor.page} of "${doc.name}"`, { threadId: toPublic("thr", threadId), commentId: toPublic("cmt", c.value.id) });
  if (updated.ok) {
    await notifyMentions(ctx, found.thread.docId as Uuid, doc.name, updated.value, mentions, text);
    await broadcast(ctx, found.thread.docId, { type: "thread", thread: publicThread(updated.value) });
  }
  return ok({ comment: publicComment(c.value) }, ctx.requestId, 201);
}

async function setStatus(ctx: Ctx, request: Request, threadId: Uuid): Promise<Response> {
  const body = await readJson(request);
  const status = body?.status === "open" || body?.status === "resolved" ? body.status : null;
  if (!status) return invalid(ctx.requestId, { status: ["open or resolved"] });
  const found = await threadAnd(ctx, threadId, "files.comment");
  if (!found) return notFound(ctx.requestId);
  const r = await ctx.repo.setStatus(ctx.orgId, threadId, status, ctx.actor.subjectId, ctx.now);
  if (!r.ok) return r.error.kind === "not_found" ? fail("conflict", "An outdated thread cannot change status", 409, ctx.requestId) : unavailable(ctx.requestId);
  await audit(ctx.events, auditCtx(ctx), found.thread.docId, status === "resolved" ? "thread.resolved" : "thread.reopened", `${status === "resolved" ? "Resolved" : "Reopened"} a comment on page ${found.thread.anchor.page}`, { threadId: toPublic("thr", threadId) });
  await broadcast(ctx, found.thread.docId, { type: "thread", thread: publicThread(r.value) });
  return ok({ thread: publicThread(r.value) }, ctx.requestId);
}

async function changeComment(ctx: Ctx, request: Request, threadId: Uuid, commentId: Uuid): Promise<Response> {
  const found = await threadAnd(ctx, threadId, "files.comment");
  if (!found || !found.thread.comments.some((c) => c.id === commentId)) return notFound(ctx.requestId);
  let r;
  if (request.method === "PATCH") {
    const body = await readJson(request);
    const text = cleanBody(body?.body);
    if (!text) return invalid(ctx.requestId, { body: [`1–${COMMENT_MAX_CHARS} characters`] });
    r = await ctx.repo.editComment(ctx.orgId, commentId, ctx.actor.subjectId, text, mentionsIn(text), ctx.now);
  } else {
    // Its author, or an editor of the document, may remove a comment.
    r = await ctx.repo.deleteComment(ctx.orgId, commentId, can(found.access, "files.write") ? null : ctx.actor.subjectId, ctx.now);
  }
  if (!r.ok) return r.error.kind === "not_found" ? notFound(ctx.requestId) : unavailable(ctx.requestId);
  await audit(ctx.events, auditCtx(ctx), found.thread.docId, request.method === "PATCH" ? "comment.edited" : "comment.deleted", `${request.method === "PATCH" ? "Edited" : "Deleted"} a comment on page ${found.thread.anchor.page}`, {
    threadId: toPublic("thr", threadId),
    commentId: toPublic("cmt", commentId),
  });
  const updated = await ctx.repo.getThread(ctx.orgId, threadId);
  if (updated.ok) await broadcast(ctx, found.thread.docId, { type: "thread", thread: publicThread(updated.value) });
  return request.method === "PATCH" ? ok({ comment: publicComment(r.value) }, ctx.requestId) : new Response(null, { status: 204 });
}

async function listRequests(ctx: Ctx, docUuid: Uuid): Promise<Response> {
  if (!can(await accessTo(ctx, docUuid), "files.read")) return notFound(ctx.requestId);
  const r = await ctx.repo.listRequests(ctx.orgId, docUuid);
  return r.ok ? ok({ requests: r.value.map(publicRequest) }, ctx.requestId) : unavailable(ctx.requestId);
}

async function createRequest(ctx: Ctx, request: Request, docUuid: Uuid): Promise<Response> {
  const body = await readJson(request);
  const reviewers = Array.isArray(body?.reviewers) ? [...new Set((body!.reviewers as unknown[]).map((e) => (typeof e === "string" ? e.trim().toLowerCase() : "")))] : [];
  const message = typeof body?.message === "string" && body.message.trim() ? body.message.trim().slice(0, 1000) : null;
  const dueRaw = body?.dueAt;
  const due = typeof dueRaw === "string" ? new Date(dueRaw) : null;
  const fields: Record<string, string[]> = {};
  if (reviewers.length < 1 || reviewers.length > 20 || reviewers.some((e) => !EMAIL.test(e) || e.length > 320)) fields.reviewers = ["1 to 20 email addresses"];
  if (dueRaw !== undefined && dueRaw !== null && (!due || Number.isNaN(due.getTime()) || due <= ctx.now || due.getTime() > ctx.now.getTime() + 365 * 86_400_000)) fields.dueAt = ["a time in the next year"];
  if (Object.keys(fields).length) return invalid(ctx.requestId, fields);
  if (!can(await accessTo(ctx, docUuid), "files.share")) return notFound(ctx.requestId);
  const doc = await ctx.drive.document(toPublic("doc", docUuid));
  // Everyone asked can open and comment: shared with them as commenters, by email, as the requester.
  for (const email of reviewers) await ctx.drive.share(toPublic("doc", docUuid), email, "commenter", message);
  // eslint-disable-next-line no-restricted-syntax -- review_* actor columns are TEXT and keep the public actor id (usr_/sp_)
  const r = await ctx.repo.createRequest({ id: newUuid(), orgId: ctx.orgId, docId: docUuid, version: doc.currentVersion, message, dueAt: due, reviewers, createdBy: ctx.actor.subjectId, now: ctx.now });
  if (!r.ok) return unavailable(ctx.requestId);
  const openUrl = ctx.env.EDITOR_URL && /^https:\/\/[^\s/]+$/.test(ctx.env.EDITOR_URL) ? `${ctx.env.EDITOR_URL}/edit/${toPublic("doc", docUuid)}?org=${ctx.orgPublic}` : null;
  for (const email of reviewers) {
    await notify(ctx.env, auditCtx(ctx), "review.requested", email, { documentName: doc.name, message, dueAt: due?.toISOString() ?? null, by: ctx.actor.email, openUrl }, [toPublic("rvr", r.value.id), email.replace(/[^A-Za-z0-9._-]/g, "_")]);
  }
  await audit(ctx.events, auditCtx(ctx), docUuid, "review_request.created", `Asked ${reviewers.length} reviewer(s) to review "${doc.name}"`, { requestId: toPublic("rvr", r.value.id), reviewers: reviewers.length, dueAt: due?.toISOString() ?? null });
  return ok({ request: publicRequest(r.value) }, ctx.requestId, 201);
}

async function decide(ctx: Ctx, request: Request, requestId: Uuid): Promise<Response> {
  const body = await readJson(request);
  const decision = body?.decision === "approved" || body?.decision === "changes_requested" ? body.decision : null;
  if (!decision) return invalid(ctx.requestId, { decision: ["approved or changes_requested"] });
  const req = await ctx.repo.getRequest(ctx.orgId, requestId);
  if (!req.ok || !ctx.actor.email || !req.value.reviewers.some((v) => v.email === ctx.actor.email)) return notFound(ctx.requestId);
  if (!can(await accessTo(ctx, req.value.docId), "files.read")) return notFound(ctx.requestId);
  const r = await ctx.repo.decide(ctx.orgId, requestId, ctx.actor.email, ctx.actor.subjectId, decision, ctx.now);
  if (!r.ok) return r.error.kind === "not_found" ? fail("conflict", "This review request is no longer open", 409, ctx.requestId) : unavailable(ctx.requestId);
  await audit(ctx.events, auditCtx(ctx), req.value.docId, "review_request.decided", `${ctx.actor.email} ${decision === "approved" ? "approved" : "asked for changes"}`, { requestId: toPublic("rvr", requestId), decision });
  return ok({ request: publicRequest(r.value) }, ctx.requestId);
}

async function cancelRequest(ctx: Ctx, requestId: Uuid): Promise<Response> {
  const req = await ctx.repo.getRequest(ctx.orgId, requestId);
  if (!req.ok) return notFound(ctx.requestId);
  const access = await accessTo(ctx, req.value.docId);
  if (!can(access, "files.read") || (req.value.createdBy !== ctx.actor.subjectId && !can(access, "files.share"))) return notFound(ctx.requestId);
  const r = await ctx.repo.cancelRequest(ctx.orgId, requestId);
  if (!r.ok) return fail("conflict", "This review request is no longer open", 409, ctx.requestId);
  await audit(ctx.events, auditCtx(ctx), req.value.docId, "review_request.canceled", "Canceled a review request", { requestId: toPublic("rvr", requestId) });
  return new Response(null, { status: 204 });
}

async function roomTicket(ctx: Ctx, docUuid: Uuid): Promise<Response> {
  const access = await accessTo(ctx, docUuid);
  if (!can(access, "files.read")) return notFound(ctx.requestId);
  const room = roomFor(ctx.env, ctx.orgId, docUuid);
  if (!room) return unavailable(ctx.requestId);
  const person = { id: ctx.actor.subjectId, name: ctx.actor.email, canEdit: can(access, "files.write"), canBreak: can(access, "files.share") };
  const res = await room.fetch("https://room/ticket", { method: "POST", body: JSON.stringify(person) });
  const { ticket, expiresAt } = (await res.json()) as { ticket: string; expiresAt: string };
  return ok({ ticket, expiresAt, canEdit: person.canEdit, canBreak: person.canBreak }, ctx.requestId, 201);
}

export async function route(request: Request, env: Env, now: Date = new Date()): Promise<Response> {
  const url = new URL(request.url);
  const header = request.headers.get("x-request-id");
  const requestId = header && REQUEST_ID.test(header) ? header : generateRequestId();
  if (url.pathname === "/health" && request.method === "GET") return ok({ ok: true, service: "review-worker", environment: env.ENVIRONMENT }, requestId);

  const m = url.pathname.match(ORG_ROUTE);
  if (!m) return notFound(requestId);
  const orgId = fromPublic("org", m[1]);
  if (!orgId) return notFound(requestId);
  const rest = m[2]!;

  // The room's WebSocket: no session (a browser cannot send one); the single-use ticket is the key.
  const roomMatch = rest.match(/^\/documents\/([^/]+)\/room$/);
  if (roomMatch && request.method === "GET") {
    const docUuid = fromPublic("doc", roomMatch[1]);
    const room = docUuid ? roomFor(env, orgId, docUuid) : null;
    if (!room) return notFound(requestId);
    const target = new URL("https://room/connect");
    target.searchParams.set("ticket", url.searchParams.get("ticket") ?? "");
    return room.fetch(new Request(target.toString(), request));
  }

  type H = (ctx: Ctx) => Promise<Response>;
  let handler: H | null = null;
  let sub: RegExpMatchArray | null;
  const method = request.method;
  if ((sub = rest.match(/^\/documents\/([^/]+)\/threads$/))) {
    const d = fromPublic("doc", sub[1]);
    if (!d) return notFound(requestId);
    handler = method === "GET" ? (c) => listThreads(c, d) : method === "POST" ? (c) => startThread(c, request, d) : null;
  } else if ((sub = rest.match(/^\/threads\/([^/]+)\/comments$/))) {
    const t = fromPublic("thr", sub[1]);
    if (!t) return notFound(requestId);
    handler = method === "POST" ? (c) => reply(c, request, t) : null;
  } else if ((sub = rest.match(/^\/threads\/([^/]+)$/))) {
    const t = fromPublic("thr", sub[1]);
    if (!t) return notFound(requestId);
    handler = method === "PATCH" ? (c) => setStatus(c, request, t) : null;
  } else if ((sub = rest.match(/^\/threads\/([^/]+)\/comments\/([^/]+)$/))) {
    const t = fromPublic("thr", sub[1]);
    const cm = fromPublic("cmt", sub[2]);
    if (!t || !cm) return notFound(requestId);
    handler = method === "PATCH" || method === "DELETE" ? (c) => changeComment(c, request, t, cm) : null;
  } else if ((sub = rest.match(/^\/documents\/([^/]+)\/review-requests$/))) {
    const d = fromPublic("doc", sub[1]);
    if (!d) return notFound(requestId);
    handler = method === "GET" ? (c) => listRequests(c, d) : method === "POST" ? (c) => createRequest(c, request, d) : null;
  } else if ((sub = rest.match(/^\/review-requests\/([^/]+)\/decision$/))) {
    const r = fromPublic("rvr", sub[1]);
    if (!r) return notFound(requestId);
    handler = method === "POST" ? (c) => decide(c, request, r) : null;
  } else if ((sub = rest.match(/^\/review-requests\/([^/]+)$/))) {
    const r = fromPublic("rvr", sub[1]);
    if (!r) return notFound(requestId);
    handler = method === "DELETE" ? (c) => cancelRequest(c, r) : null;
  } else if ((sub = rest.match(/^\/documents\/([^/]+)\/room\/ticket$/))) {
    const d = fromPublic("doc", sub[1]);
    if (!d) return notFound(requestId);
    handler = method === "POST" ? (c) => roomTicket(c, d) : null;
  } else return notFound(requestId);
  if (!handler) return methodNotAllowed(requestId);

  const actor = resolveActor(request);
  if (!actor) return fail("unauthenticated", "Authentication required", 401, requestId);
  if (!env.PLATFORM_DB || !env.FILES_WORKER) return unavailable(requestId);
  const executor = createSqlExecutor(env.PLATFORM_DB as never);
  const orgPublic = toPublic("org", orgId);
  try {
    return await handler({ env, requestId, actor, orgId, orgPublic, repo: createReviewRepository(executor), drive: driveFor(env, orgPublic, actor, requestId), events: createEventsRepository(executor), now });
  } catch (e) {
    if (e instanceof DriveError && e.status === 404) return notFound(requestId);
    if (e instanceof DriveError && e.status === 422) return invalid(requestId, { reviewers: [e.message] });
    console.error(JSON.stringify({ level: "error", msg: "review-worker request failed", requestId, error: e instanceof Error ? e.name : "unknown" }));
    return unavailable(requestId);
  } finally {
    await executor.dispose();
  }
}
