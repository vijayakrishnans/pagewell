import { SIGN_LIMITS, type EnvelopeInput, type FieldKind, type SigningSession } from "@saas/contracts/sign";
import { LINK_MAX_DAYS } from "@saas/contracts/sharing";
import { createSqlExecutor } from "@saas/db/d1";
import { createEventsRepository } from "@saas/db/events";
import { createSignRepository, currentWave, OTP_MAX_ATTEMPTS, type DraftInput, type Envelope, type FieldValue, type SignRepository, type Signer } from "@saas/db/sign";
import type { Uuid } from "@saas/db/ids";
import { sha256Hex, verifyChain, type EvidenceEvent } from "@saas/shared/evidence";
import { audit } from "./audit.js";
import { DriveError, driveFor, type Actor, type Drive } from "./drive.js";
import type { Env } from "./env.js";
import { EvidenceError, record } from "./evidence.js";
import { advance, dueNow, hashCode, hashToken, issueLinks, type FlowCtx } from "./flow.js";
import { fail, invalid, methodNotAllowed, notFound, ok, readJson, unavailable } from "./http.js";
import { fromPublic, generateRequestId, newCode, orderedUuid, toPublic } from "./ids.js";
import { notify } from "./notify.js";
import { publicEnvelope } from "./public.js";

// E-sign (PW6). Two kinds of route, both behind api-edge:
//
// The sender's, signed in (api-edge sets the actor headers), under /v1/organizations/{org}:
//   GET|POST /envelopes                    the caller's envelopes | a new draft
//   GET|PATCH /envelopes/{env}             one envelope | change a draft
//   POST /envelopes/{env}/send             freeze the documents, give the first signers links
//   POST /envelopes/{env}/resend           new links for whoever's turn it is
//   POST /envelopes/{env}/void             {reason}
//   GET  /envelopes/{env}/evidence         the evidence log and whether its chain verifies
// Making, sending and managing an envelope needs `share` on every document in it (signers see
// them); seeing it needs that or being its sender. Every miss is the same 404.
//
// The signer's, with no account, under /v1/s/{token} (the link token is the key; expired, spent
// and unknown links are the same 404):
//   GET  /                                  what to sign (their own fields only)
//   POST /code                              email a one-time code
//   POST /verify                            {code}
//   GET  /documents/{doc}                   a document as sent (after verifying)
//   POST /submit                            {consent: true, values}
//   POST /decline                           {reason}

const REQUEST_ID = /^[\w-]{1,128}$/;
const ORG_ROUTE = /^\/v1\/organizations\/([^/]+)(\/envelopes(?:\/.*)?)$/;
const SIGN_ROUTE = /^\/v1\/s\/([A-Za-z0-9_-]{20,100})(\/.*)?$/;
const EMAIL = /^[^\s@]{1,200}@[^\s@]{1,200}\.[^\s@]{1,63}$/;
const KINDS: FieldKind[] = ["signature", "initials", "date", "text", "checkbox"];
const DAY = 86_400_000;
const CODE_RESEND_MS = 30_000;

interface Ctx {
  env: Env;
  requestId: string;
  actor: Actor;
  orgId: Uuid;
  orgPublic: string;
  repo: SignRepository;
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

const flowCtx = (ctx: Ctx): FlowCtx => ({ env: ctx.env, repo: ctx.repo, orgId: ctx.orgId, requestId: ctx.requestId, actor: { type: ctx.actor.subjectType, id: ctx.actor.subjectId }, now: ctx.now, events: ctx.events });
const auditCtx = (ctx: { orgId: string; requestId: string; now: Date }, actor: { type: string; id: string }) => ({ orgId: ctx.orgId, actor, requestId: ctx.requestId, now: ctx.now });

const printable = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const s = v.replace(/\r\n/g, "\n").trim();
  return s.length >= 1 && s.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s) ? s : null;
};

/** May the caller manage this envelope: share on every document in it. */
async function mayShareAll(ctx: Ctx, docIds: string[]): Promise<boolean> {
  for (const d of docIds) {
    const a = await ctx.drive.access(toPublic("doc", d));
    if (!a?.actions.includes("files.share" as never)) return false;
  }
  return true;
}

async function visibleEnvelope(ctx: Ctx, envelopeId: Uuid, manage: boolean): Promise<Envelope | null> {
  const r = await ctx.repo.getEnvelope(ctx.orgId, envelopeId);
  if (!r.ok) return null;
  const e = r.value;
  if (!manage && e.createdBy === ctx.actor.subjectId) return e;
  return (await mayShareAll(ctx, e.documents.map((d) => d.docId))) ? e : null;
}

/** Validate a draft body into the repository's shape, with the drive's page counts. */
async function draftFrom(ctx: Ctx, body: Record<string, unknown> | null): Promise<{ draft: DraftInput } | { fields: Record<string, string[]> }> {
  const input = (body ?? {}) as Partial<EnvelopeInput>;
  const errors: Record<string, string[]> = {};
  const title = printable(input.title, SIGN_LIMITS.titleChars);
  if (!title) errors.title = [`1–${SIGN_LIMITS.titleChars} characters`];
  const message = input.message === undefined || input.message === null || input.message === "" ? null : printable(input.message, SIGN_LIMITS.messageChars);
  if (input.message && !message) errors.message = [`at most ${SIGN_LIMITS.messageChars} characters`];
  const orderMode = input.orderMode ?? "parallel";
  if (orderMode !== "parallel" && orderMode !== "sequential") errors.orderMode = ["parallel or sequential"];
  let expiresAt = new Date(ctx.now.getTime() + 30 * DAY);
  if (input.expiresAt) {
    const t = Date.parse(String(input.expiresAt));
    if (Number.isNaN(t) || t <= ctx.now.getTime() + 60 * 60_000 || t > ctx.now.getTime() + LINK_MAX_DAYS * DAY) errors.expiresAt = ["a time from an hour to a year ahead"];
    else expiresAt = new Date(t);
  }
  const reminderDays = input.reminderDays === undefined || input.reminderDays === null ? null : input.reminderDays;
  if (reminderDays !== null && (!Number.isInteger(reminderDays) || reminderDays < 1 || reminderDays > 30)) errors.reminderDays = ["1 to 30, or null"];

  const docs = Array.isArray(input.documents) ? input.documents : [];
  if (docs.length < 1 || docs.length > SIGN_LIMITS.documents) errors.documents = [`1 to ${SIGN_LIMITS.documents} documents`];
  const documents: DraftInput["documents"] = [];
  const pageCounts = new Map<string, number>();
  for (const d of docs.slice(0, SIGN_LIMITS.documents)) {
    const uuid = fromPublic("doc", (d as { documentId?: string })?.documentId);
    if (!uuid || documents.some((x) => x.docId === uuid)) {
      errors.documents = ["document ids, each once"];
      continue;
    }
    let doc;
    try {
      doc = await ctx.drive.document(toPublic("doc", uuid));
    } catch (e) {
      if (e instanceof DriveError && e.status === 404) {
        errors.documents = ["a document you cannot share"];
        continue;
      }
      throw e;
    }
    if (doc.deletedAt) {
      errors.documents = ["a document in the trash"];
      continue;
    }
    documents.push({ docId: uuid, name: doc.name });
    pageCounts.set(uuid, doc.pageCount ?? 10_000);
  }

  const raw = Array.isArray(input.signers) ? input.signers : [];
  if (raw.length < 1 || raw.length > SIGN_LIMITS.signers) errors.signers = [`1 to ${SIGN_LIMITS.signers} signers`];
  const signers: DraftInput["signers"] = [];
  const byKey = new Map<string, string>();
  for (const s of raw.slice(0, SIGN_LIMITS.signers)) {
    const key = typeof s?.key === "string" && s.key.length <= 64 ? s.key : null;
    const name = printable(s?.name, 200);
    const email = typeof s?.email === "string" ? s.email.trim().toLowerCase() : "";
    const order = orderMode === "parallel" ? 1 : s?.order ?? 1;
    if (!key || byKey.has(key) || !name || !EMAIL.test(email) || signers.some((x) => x.email === email) || !Number.isInteger(order) || order < 1 || order > 50) {
      errors.signers = ["each: a unique key, a name, a unique email, an order from 1 to 50"];
      continue;
    }
    const id = orderedUuid(ctx.now);
    byKey.set(key, id);
    signers.push({ id, name, email, order });
  }

  const rawFields = Array.isArray(input.fields) ? input.fields : [];
  if (rawFields.length > SIGN_LIMITS.fieldsPerEnvelope) errors.fields = [`at most ${SIGN_LIMITS.fieldsPerEnvelope} fields`];
  const fields: DraftInput["fields"] = [];
  for (const f of rawFields.slice(0, SIGN_LIMITS.fieldsPerEnvelope)) {
    const signerId = byKey.get(String(f?.signer));
    const docId = fromPublic("doc", f?.documentId);
    const pages = docId ? pageCounts.get(docId) : undefined;
    const rect = f?.rect;
    const okRect = Array.isArray(rect) && rect.length === 4 && rect.every((n, i) => typeof n === "number" && Number.isFinite(n) && n >= (i < 2 ? 0 : 1) && n <= 14_400);
    const label = f?.label === undefined || f?.label === null ? null : printable(f.label, 100);
    if (!signerId || !docId || pages === undefined || !Number.isInteger(f?.page) || f.page < 1 || f.page > pages || !okRect || !KINDS.includes(f?.kind as FieldKind) || (f?.label && !label)) {
      errors.fields = ["each: a signer key, one of the documents, a page in it, [x, y, w, h], a kind"];
      continue;
    }
    fields.push({ id: orderedUuid(ctx.now), signerId: signerId as Uuid, docId, page: f.page, rect: rect as [number, number, number, number], kind: f.kind as FieldKind, required: f.required !== false, label });
  }
  for (const s of signers) {
    if (!fields.some((f) => f.signerId === s.id && (f.kind === "signature" || f.kind === "initials"))) errors.fields = [`every signer needs a signature or initials field (${s.email} has none)`];
  }
  if (Object.keys(errors).length) return { fields: errors };
  return { draft: { title: title!, message, orderMode, expiresAt, reminderDays, documents, signers, fields } };
}

// ---- the sender's routes ----

async function createEnvelope(ctx: Ctx, request: Request): Promise<Response> {
  const parsed = await draftFrom(ctx, await readJson(request));
  if ("fields" in parsed) return invalid(ctx.requestId, parsed.fields);
  if (!(await mayShareAll(ctx, parsed.draft.documents.map((d) => d.docId)))) return notFound(ctx.requestId);
  const id = orderedUuid(ctx.now);
  // eslint-disable-next-line no-restricted-syntax -- sign_envelopes.created_by is TEXT and keeps the public actor id (usr_/sp_), as the drive is asked as that actor
  const r = await ctx.repo.createDraft({ ...parsed.draft, id, orgId: ctx.orgId, createdBy: ctx.actor.subjectId, senderEmail: ctx.actor.email, now: ctx.now });
  if (!r.ok) return unavailable(ctx.requestId);
  await record(ctx.repo, ctx.orgId, id, "envelope.created", { by: ctx.actor.subjectId, title: r.value.title, signers: r.value.signers.length, documents: r.value.documents.length }, ctx.now);
  await audit(ctx.events, auditCtx(ctx, { type: ctx.actor.subjectType, id: ctx.actor.subjectId }), parsed.draft.documents[0]!.docId, "envelope.created", `Envelope "${r.value.title}" drafted`, { envelopeId: toPublic("env", id) });
  return ok({ envelope: publicEnvelope(r.value) }, ctx.requestId, 201);
}

async function listEnvelopes(ctx: Ctx, url: URL): Promise<Response> {
  const status = url.searchParams.get("status");
  const r = await ctx.repo.listEnvelopes(ctx.orgId, { limit: 100, ...(status ? { status: status as Envelope["status"] } : {}) });
  if (!r.ok) return unavailable(ctx.requestId);
  const mine = r.value.filter((e) => e.createdBy === ctx.actor.subjectId);
  return ok({ envelopes: mine.map(publicEnvelope), nextCursor: null }, ctx.requestId);
}

async function getEnvelope(ctx: Ctx, envelopeId: Uuid): Promise<Response> {
  const e = await visibleEnvelope(ctx, envelopeId, false);
  return e ? ok({ envelope: publicEnvelope(e) }, ctx.requestId) : notFound(ctx.requestId);
}

async function updateEnvelope(ctx: Ctx, request: Request, envelopeId: Uuid): Promise<Response> {
  const e = await visibleEnvelope(ctx, envelopeId, true);
  if (!e) return notFound(ctx.requestId);
  if (e.status !== "draft") return fail("conflict", "Only a draft can be changed", 409, ctx.requestId);
  const parsed = await draftFrom(ctx, await readJson(request));
  if ("fields" in parsed) return invalid(ctx.requestId, parsed.fields);
  if (!(await mayShareAll(ctx, parsed.draft.documents.map((d) => d.docId)))) return notFound(ctx.requestId);
  const r = await ctx.repo.updateDraft(ctx.orgId, envelopeId, parsed.draft, ctx.now);
  if (!r.ok) return r.error.kind === "conflict" ? fail("conflict", "Only a draft can be changed", 409, ctx.requestId) : unavailable(ctx.requestId);
  return ok({ envelope: publicEnvelope(r.value) }, ctx.requestId);
}

async function sendEnvelope(ctx: Ctx, envelopeId: Uuid): Promise<Response> {
  const e = await visibleEnvelope(ctx, envelopeId, true);
  if (!e) return notFound(ctx.requestId);
  if (e.status !== "draft") return fail("conflict", "This envelope was already sent", 409, ctx.requestId);
  // Freeze each document at its current version: its bytes' hash and page count.
  const frozen = [];
  for (const d of e.documents) {
    const doc = await ctx.drive.document(toPublic("doc", d.docId));
    const { bytes, version } = await ctx.drive.content(toPublic("doc", d.docId), null);
    frozen.push({ docId: d.docId as Uuid, version, sha256: await sha256Hex(bytes), pageCount: doc.pageCount ?? 0 });
  }
  const r = await ctx.repo.send(ctx.orgId, envelopeId, frozen, ctx.now);
  if (!r.ok) return r.error.kind === "conflict" ? fail("conflict", "This envelope was already sent", 409, ctx.requestId) : unavailable(ctx.requestId);
  await record(ctx.repo, ctx.orgId, envelopeId, "envelope.sent", { by: ctx.actor.subjectId, orderMode: r.value.orderMode, documents: frozen.map((f) => ({ document: toPublic("doc", f.docId), version: f.version, sha256: f.sha256, pages: f.pageCount })), signers: r.value.signers.map((s) => ({ signer: toPublic("sgn", s.id), email: s.email, order: s.order })) }, ctx.now);
  const links = await issueLinks(flowCtx(ctx), r.value, dueNow(r.value), "sent");
  await audit(ctx.events, auditCtx(ctx, { type: ctx.actor.subjectType, id: ctx.actor.subjectId }), e.documents[0]!.docId, "envelope.sent", `Envelope "${e.title}" sent for signature`, { envelopeId: toPublic("env", envelopeId), signers: r.value.signers.length });
  const after = await ctx.repo.getEnvelope(ctx.orgId, envelopeId);
  return ok({ envelope: publicEnvelope(after.ok ? after.value : r.value), ...(ctx.env.DEBUG_DELIVERY === "true" ? { delivery: { mode: "local_debug", links } } : {}) }, ctx.requestId);
}

async function resendEnvelope(ctx: Ctx, envelopeId: Uuid): Promise<Response> {
  const e = await visibleEnvelope(ctx, envelopeId, true);
  if (!e) return notFound(ctx.requestId);
  if (e.status !== "sent") return fail("conflict", "Only a sent envelope can be resent", 409, ctx.requestId);
  const wave = currentWave(e.signers);
  const due = e.signers.filter((s) => (s.status === "notified" || s.status === "viewed" || s.status === "pending") && (e.orderMode === "parallel" || s.order === wave));
  const links = await issueLinks(flowCtx(ctx), e, due, "resend");
  return ok({ resent: links.length, ...(ctx.env.DEBUG_DELIVERY === "true" ? { delivery: { mode: "local_debug", links } } : {}) }, ctx.requestId);
}

async function voidEnvelope(ctx: Ctx, request: Request, envelopeId: Uuid): Promise<Response> {
  const e = await visibleEnvelope(ctx, envelopeId, true);
  if (!e) return notFound(ctx.requestId);
  const body = await readJson(request);
  const reason = body?.reason === undefined || body?.reason === null || body?.reason === "" ? null : printable(body.reason, 1000);
  if (body?.reason && !reason) return invalid(ctx.requestId, { reason: ["at most 1000 characters"] });
  const r = await ctx.repo.void(ctx.orgId, envelopeId, reason, ctx.now);
  if (!r.ok) return r.error.kind === "conflict" ? fail("conflict", "Only a draft or a sent envelope can be voided", 409, ctx.requestId) : unavailable(ctx.requestId);
  await record(ctx.repo, ctx.orgId, envelopeId, "envelope.voided", { by: ctx.actor.subjectId, reason }, ctx.now);
  for (const s of e.signers.filter((x) => x.status === "notified" || x.status === "viewed")) {
    await notify(ctx.env, { orgId: ctx.orgId, actor: { type: ctx.actor.subjectType, id: ctx.actor.subjectId }, requestId: ctx.requestId }, "sign.voided", s.email, { title: e.title, from: e.senderEmail, reason }, [toPublic("env", envelopeId), toPublic("sgn", s.id)]);
  }
  await audit(ctx.events, auditCtx(ctx, { type: ctx.actor.subjectType, id: ctx.actor.subjectId }), e.documents[0]!.docId, "envelope.voided", `Envelope "${e.title}" voided`, { envelopeId: toPublic("env", envelopeId) });
  return ok({ envelope: publicEnvelope(r.value) }, ctx.requestId);
}

async function evidence(ctx: Ctx, envelopeId: Uuid): Promise<Response> {
  const e = await visibleEnvelope(ctx, envelopeId, false);
  if (!e) return notFound(ctx.requestId);
  const r = await ctx.repo.listEvents(ctx.orgId, envelopeId);
  if (!r.ok) return unavailable(ctx.requestId);
  const events = r.value as EvidenceEvent[];
  return ok({ events, verdict: await verifyChain(events) }, ctx.requestId);
}

// ---- the signer's routes ----

interface SignCtx {
  env: Env;
  repo: SignRepository;
  requestId: string;
  now: Date;
  signer: Signer;
  envelope: Envelope;
  orgId: Uuid;
  events: ReturnType<typeof createEventsRepository>;
  meta: { ip: string | null; userAgent: string | null };
}

const signerActor = (c: SignCtx) => ({ type: "signer", id: toPublic("sgn", c.signer.id) });
const signFlow = (c: SignCtx): FlowCtx => ({ env: c.env, repo: c.repo, orgId: c.orgId, requestId: c.requestId, actor: signerActor(c), now: c.now, events: c.events });
const yourTurn = (e: Envelope, s: Signer) => e.orderMode === "parallel" || currentWave(e.signers) === s.order;
const senderDrive = (c: SignCtx) => driveFor(c.env, toPublic("org", c.orgId), { subjectId: c.envelope.createdBy, subjectType: "user", email: c.envelope.senderEmail }, c.requestId);

async function session(c: SignCtx): Promise<Response> {
  if (!c.signer.viewedAt) {
    await c.repo.markViewed(c.orgId, c.signer.id as Uuid, c.now);
    await record(c.repo, c.orgId, c.envelope.id as Uuid, "signer.viewed", { signer: toPublic("sgn", c.signer.id), ip: c.meta.ip, userAgent: c.meta.userAgent }, c.now);
  }
  const e = c.envelope;
  const s: SigningSession = {
    envelope: { title: e.title, message: e.message, from: e.senderEmail, orderMode: e.orderMode, expiresAt: e.expiresAt?.toISOString() ?? null },
    signer: { name: c.signer.name, email: c.signer.email, status: c.signer.status === "notified" ? "viewed" : c.signer.status, verified: Boolean(c.signer.verifiedAt) },
    yourTurn: yourTurn(e, c.signer),
    documents: e.documents.map((d) => ({ documentId: toPublic("doc", d.docId), name: d.name, pageCount: d.pageCount })),
    fields: e.fields.filter((f) => f.signerId === c.signer.id).map((f) => ({ id: toPublic("fdl", f.id), documentId: toPublic("doc", f.docId), page: f.page, rect: f.rect, kind: f.kind, required: f.required, label: f.label })),
    others: e.signers.filter((x) => x.id !== c.signer.id).map((x) => ({ name: x.name, status: x.status })),
  };
  return ok({ session: s }, c.requestId);
}

async function sendCode(c: SignCtx): Promise<Response> {
  const sentAt = c.signer.otpExpiresAt ? c.signer.otpExpiresAt.getTime() - SIGN_LIMITS.otpTtlMinutes * 60_000 : 0;
  if (c.now.getTime() - sentAt < CODE_RESEND_MS) return fail("rate_limited", "A code was sent a moment ago", 429, c.requestId);
  const code = newCode();
  const r = await c.repo.setOtp(c.orgId, c.signer.id as Uuid, await hashCode(c.signer.id, code), new Date(c.now.getTime() + SIGN_LIMITS.otpTtlMinutes * 60_000));
  if (!r.ok) return notFound(c.requestId);
  await record(c.repo, c.orgId, c.envelope.id as Uuid, "signer.code_sent", { signer: toPublic("sgn", c.signer.id), email: c.signer.email }, c.now);
  await notify(c.env, { orgId: c.orgId, actor: signerActor(c), requestId: c.requestId }, "sign.code", c.signer.email, { code, title: c.envelope.title, minutes: SIGN_LIMITS.otpTtlMinutes }, [toPublic("sgn", c.signer.id), String(c.now.getTime())]);
  return ok({ sent: true, ...(c.env.DEBUG_DELIVERY === "true" ? { delivery: { mode: "local_debug", code } } : {}) }, c.requestId);
}

async function verifyCode(c: SignCtx, request: Request): Promise<Response> {
  const body = await readJson(request);
  const code = typeof body?.code === "string" && /^\d{6}$/.test(body.code) ? body.code : null;
  if (!code) return invalid(c.requestId, { code: ["six digits"] });
  const r = await c.repo.checkOtp(c.orgId, c.signer.id as Uuid, await hashCode(c.signer.id, code), c.now);
  if (!r.ok) return notFound(c.requestId);
  const { matched, signer } = r.value;
  await record(c.repo, c.orgId, c.envelope.id as Uuid, matched ? "signer.verified" : "signer.code_failed", { signer: toPublic("sgn", c.signer.id), ip: c.meta.ip, ...(matched ? {} : { attempts: signer.otpAttempts }) }, c.now);
  if (!matched) return fail("validation_failed", "That code is wrong or has expired", 422, c.requestId, { attemptsLeft: signer.otpExpiresAt && signer.otpAttempts < OTP_MAX_ATTEMPTS ? OTP_MAX_ATTEMPTS - signer.otpAttempts : 0 });
  return ok({ verified: true }, c.requestId);
}

async function documentAsSent(c: SignCtx, docPublic: string): Promise<Response> {
  if (!c.signer.verifiedAt) return fail("forbidden", "Verify your email address first", 403, c.requestId);
  const d = c.envelope.documents.find((x) => toPublic("doc", x.docId) === docPublic);
  if (!d || !d.version) return notFound(c.requestId);
  const { bytes } = await senderDrive(c).content(docPublic, d.version);
  return new Response(bytes, { headers: { "content-type": "application/pdf", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-disposition": `inline; filename="${d.name.replace(/[^\w .-]/g, "_")}"` } });
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
function pngFrom(b64: unknown): Uint8Array | null {
  if (typeof b64 !== "string" || b64.length > Math.ceil((SIGN_LIMITS.signatureImageBytes * 4) / 3) + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    return null;
  }
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return bytes.length > 64 && bytes.length <= SIGN_LIMITS.signatureImageBytes && PNG.every((v, i) => bytes[i] === v) ? bytes : null;
}

async function submit(c: SignCtx, request: Request): Promise<Response> {
  if (!c.signer.verifiedAt) return fail("forbidden", "Verify your email address first", 403, c.requestId);
  if (!yourTurn(c.envelope, c.signer)) return fail("conflict", "It is not your turn to sign yet", 409, c.requestId);
  const body = await readJson(request);
  if (body?.consent !== true) return invalid(c.requestId, { consent: ["agree to sign electronically"] });
  const mine = new Map(c.envelope.fields.filter((f) => f.signerId === c.signer.id).map((f) => [toPublic("fdl", f.id), f]));
  const values: Array<{ fieldId: Uuid; value: FieldValue }> = [];
  const summary: Array<{ field: string; kind: string; sha256: string }> = [];
  const raw = Array.isArray(body?.values) ? (body!.values as Array<Record<string, unknown>>) : [];
  if (raw.length > mine.size) return invalid(c.requestId, { values: ["only your fields"] });
  for (const v of raw) {
    const f = mine.get(String(v?.fieldId));
    if (!f) return invalid(c.requestId, { values: ["only your fields"] });
    let value: FieldValue;
    if (f.kind === "checkbox") {
      if (typeof v.checked !== "boolean") return invalid(c.requestId, { values: [`${toPublic("fdl", f.id)}: checked true or false`] });
      if (!v.checked && f.required) return invalid(c.requestId, { values: [`${toPublic("fdl", f.id)}: must be checked`] });
      value = { checked: v.checked };
    } else if (f.kind === "date") {
      value = { text: c.now.toISOString().slice(0, 10) }; // the date signed, set here, not by the signer
    } else if ((f.kind === "signature" || f.kind === "initials") && v.imagePng !== undefined) {
      const png = pngFrom(v.imagePng);
      if (!png || !c.env.FILES_BUCKET) return invalid(c.requestId, { values: [`${toPublic("fdl", f.id)}: a PNG up to ${SIGN_LIMITS.signatureImageBytes / 1024} KiB`] });
      const key = `org/${c.orgId}/sign/${c.envelope.id}/${f.id}.png`;
      await c.env.FILES_BUCKET.put(key, png, { httpMetadata: { contentType: "image/png" } });
      value = { imageKey: key };
      summary.push({ field: toPublic("fdl", f.id), kind: f.kind, sha256: await sha256Hex(png) });
    } else {
      const text = printable(v.text, f.kind === "text" ? SIGN_LIMITS.textValueChars : 100);
      if (!text) return invalid(c.requestId, { values: [`${toPublic("fdl", f.id)}: text, 1–${f.kind === "text" ? SIGN_LIMITS.textValueChars : 100} characters`] });
      value = { text };
    }
    if (!("imageKey" in value)) summary.push({ field: toPublic("fdl", f.id), kind: f.kind, sha256: await sha256Hex(JSON.stringify(value)) });
    values.push({ fieldId: f.id as Uuid, value });
  }
  // Date fields are filled even if the page did not send them.
  for (const f of mine.values()) {
    if (f.kind === "date" && !values.some((x) => x.fieldId === f.id)) {
      const value = { text: c.now.toISOString().slice(0, 10) };
      values.push({ fieldId: f.id as Uuid, value });
      summary.push({ field: toPublic("fdl", f.id), kind: f.kind, sha256: await sha256Hex(JSON.stringify(value)) });
    }
  }
  const r = await c.repo.submit(c.orgId, c.signer.id as Uuid, values, c.meta, c.now);
  if (!r.ok) return r.error.kind === "conflict" ? fail("conflict", r.error.message, 409, c.requestId) : r.error.kind === "not_found" ? notFound(c.requestId) : unavailable(c.requestId);
  await record(c.repo, c.orgId, c.envelope.id as Uuid, "signer.signed", { signer: toPublic("sgn", c.signer.id), email: c.signer.email, consent: true, ip: c.meta.ip, userAgent: c.meta.userAgent, fields: summary }, c.now);
  await audit(c.events, auditCtx(c, signerActor(c)), c.envelope.documents[0]!.docId, "envelope.signed", `${c.signer.email} signed "${c.envelope.title}"`, { envelopeId: toPublic("env", c.envelope.id), signer: toPublic("sgn", c.signer.id) });
  await advance(signFlow(c), r.value);
  const after = await c.repo.getEnvelope(c.orgId, c.envelope.id as Uuid);
  return ok({ signed: true, envelopeStatus: after.ok ? after.value.status : r.value.status }, c.requestId);
}

async function decline(c: SignCtx, request: Request): Promise<Response> {
  const body = await readJson(request);
  const reason = body?.reason === undefined || body?.reason === null || body?.reason === "" ? null : printable(body.reason, 1000);
  if (body?.reason && !reason) return invalid(c.requestId, { reason: ["at most 1000 characters"] });
  const r = await c.repo.decline(c.orgId, c.signer.id as Uuid, reason, c.meta, c.now);
  if (!r.ok) return r.error.kind === "conflict" ? fail("conflict", "This can no longer be declined", 409, c.requestId) : unavailable(c.requestId);
  await record(c.repo, c.orgId, c.envelope.id as Uuid, "signer.declined", { signer: toPublic("sgn", c.signer.id), email: c.signer.email, reason, ip: c.meta.ip }, c.now);
  await audit(c.events, auditCtx(c, signerActor(c)), c.envelope.documents[0]!.docId, "envelope.declined", `${c.signer.email} declined "${c.envelope.title}"`, { envelopeId: toPublic("env", c.envelope.id) });
  if (c.envelope.senderEmail) await notify(c.env, { orgId: c.orgId, actor: signerActor(c), requestId: c.requestId }, "sign.declined", c.envelope.senderEmail, { title: c.envelope.title, signerName: c.signer.name, signerEmail: c.signer.email, reason }, [toPublic("env", c.envelope.id)]);
  return ok({ declined: true }, c.requestId);
}

async function signRoute(request: Request, env: Env, requestId: string, now: Date, token: string, rest: string): Promise<Response> {
  if (!env.PLATFORM_DB) return unavailable(requestId);
  const executor = createSqlExecutor(env.PLATFORM_DB as never);
  try {
    const repo = createSignRepository(executor);
    const found = await repo.signerByToken(await hashToken(token), now);
    if (!found.ok) return found.error.kind === "not_found" ? notFound(requestId) : unavailable(requestId);
    const ip = request.headers.get("cf-connecting-ip");
    const c: SignCtx = {
      env,
      repo,
      requestId,
      now,
      signer: found.value.signer,
      envelope: found.value.envelope,
      orgId: found.value.signer.orgId as Uuid,
      events: createEventsRepository(executor),
      meta: { ip: ip && ip.length <= 64 ? ip : null, userAgent: request.headers.get("user-agent")?.slice(0, 300) ?? null },
    };
    const m = request.method;
    let sub: RegExpMatchArray | null;
    if (rest === "" || rest === "/") return m === "GET" ? await session(c) : methodNotAllowed(requestId);
    if (rest === "/code") return m === "POST" ? await sendCode(c) : methodNotAllowed(requestId);
    if (rest === "/verify") return m === "POST" ? await verifyCode(c, request) : methodNotAllowed(requestId);
    if (rest === "/submit") return m === "POST" ? await submit(c, request) : methodNotAllowed(requestId);
    if (rest === "/decline") return m === "POST" ? await decline(c, request) : methodNotAllowed(requestId);
    if ((sub = rest.match(/^\/documents\/(doc_[0-9a-f]{32})$/))) return m === "GET" ? await documentAsSent(c, sub[1]!) : methodNotAllowed(requestId);
    return notFound(requestId);
  } catch (e) {
    if (e instanceof DriveError && e.status === 404) return notFound(requestId);
    console.error(JSON.stringify({ level: "error", msg: "sign-worker signing request failed", requestId, error: e instanceof EvidenceError ? "evidence" : e instanceof Error ? e.name : "unknown" }));
    return unavailable(requestId);
  } finally {
    await executor.dispose();
  }
}

export async function route(request: Request, env: Env, now: Date = new Date()): Promise<Response> {
  const asked = request.headers.get("x-request-id");
  const requestId = asked && REQUEST_ID.test(asked) ? asked : generateRequestId();
  const url = new URL(request.url);

  const s = url.pathname.match(SIGN_ROUTE);
  if (s) return signRoute(request, env, requestId, now, s[1]!, s[2] ?? "");

  const m = url.pathname.match(ORG_ROUTE);
  if (!m) return notFound(requestId);
  const orgId = fromPublic("org", m[1]);
  if (!orgId) return notFound(requestId);
  const rest = m[2]!;
  const method = request.method;
  type H = (ctx: Ctx) => Promise<Response>;
  let handler: H | null = null;
  let sub: RegExpMatchArray | null;
  if (rest === "/envelopes") {
    handler = method === "GET" ? (c) => listEnvelopes(c, url) : method === "POST" ? (c) => createEnvelope(c, request) : null;
  } else if ((sub = rest.match(/^\/envelopes\/([^/]+)(\/[a-z]+)?$/))) {
    const e = fromPublic("env", sub[1]);
    if (!e) return notFound(requestId);
    const action = sub[2] ?? "";
    if (action === "") handler = method === "GET" ? (c) => getEnvelope(c, e) : method === "PATCH" ? (c) => updateEnvelope(c, request, e) : null;
    else if (action === "/send") handler = method === "POST" ? (c) => sendEnvelope(c, e) : null;
    else if (action === "/resend") handler = method === "POST" ? (c) => resendEnvelope(c, e) : null;
    else if (action === "/void") handler = method === "POST" ? (c) => voidEnvelope(c, request, e) : null;
    else if (action === "/evidence") handler = method === "GET" ? (c) => evidence(c, e) : null;
    else return notFound(requestId);
  } else return notFound(requestId);
  if (!handler) return methodNotAllowed(requestId);

  const actor = resolveActor(request);
  if (!actor) return fail("unauthenticated", "Authentication required", 401, requestId);
  if (!env.PLATFORM_DB || !env.FILES_WORKER) return unavailable(requestId);
  const executor = createSqlExecutor(env.PLATFORM_DB as never);
  const orgPublic = toPublic("org", orgId);
  try {
    return await handler({ env, requestId, actor, orgId, orgPublic, repo: createSignRepository(executor), drive: driveFor(env, orgPublic, actor, requestId), events: createEventsRepository(executor), now });
  } catch (e) {
    if (e instanceof DriveError && e.status === 404) return notFound(requestId);
    console.error(JSON.stringify({ level: "error", msg: "sign-worker request failed", requestId, error: e instanceof EvidenceError ? "evidence" : e instanceof Error ? e.name : "unknown" }));
    return unavailable(requestId);
  } finally {
    await executor.dispose();
  }
}
