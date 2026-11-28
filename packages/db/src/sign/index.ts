import type { SqlExecutor, SqlRow } from "../d1/executor.js";
import { executeBatch } from "../d1/executor.js";
import type { Uuid } from "../ids/index.js";

// Pagewell's e-sign (PW6): envelopes, their documents, signers, fields and the evidence log.
// Every statement names org_id except `signerByToken` (the public signing route knows only the
// link token) and the housekeeping reads across orgs (reminders, expiry); those hand back rows
// that carry their org. Link tokens and email codes arrive here already hashed.
//
// The evidence log is append-only (the table's triggers refuse UPDATE and DELETE). This module
// stores events; @saas/shared/evidence computes and checks their hashes.

export type EnvelopeStatus = "draft" | "sent" | "completing" | "completed" | "declined" | "expired" | "voided";
export type OrderMode = "parallel" | "sequential";
export type SignerStatus = "pending" | "notified" | "viewed" | "signed" | "declined";
export type FieldKind = "signature" | "initials" | "date" | "text" | "checkbox";
export type FieldValue = { text: string } | { checked: boolean } | { imageKey: string };

export interface EnvelopeDocument {
  docId: string;
  position: number;
  name: string;
  version: number | null;
  sha256: string | null;
  pageCount: number | null;
}

export interface Signer {
  id: string;
  orgId: string;
  envelopeId: string;
  name: string;
  email: string;
  order: number;
  status: SignerStatus;
  tokenExpiresAt: Date | null;
  otpExpiresAt: Date | null;
  otpAttempts: number;
  verifiedAt: Date | null;
  notifiedAt: Date | null;
  viewedAt: Date | null;
  signedAt: Date | null;
  declinedAt: Date | null;
  declineReason: string | null;
  ip: string | null;
  userAgent: string | null;
  remindedAt: Date | null;
}

export interface Field {
  id: string;
  signerId: string;
  docId: string;
  page: number;
  rect: [number, number, number, number];
  kind: FieldKind;
  required: boolean;
  label: string | null;
  value: FieldValue | null;
  filledAt: Date | null;
}

export interface Envelope {
  id: string;
  orgId: string;
  title: string;
  message: string | null;
  status: EnvelopeStatus;
  orderMode: OrderMode;
  expiresAt: Date | null;
  reminderDays: number | null;
  createdBy: string;
  /** The sender's email when they made it (from 251_sign_sender). */
  senderEmail: string | null;
  createdAt: Date;
  updatedAt: Date;
  sentAt: Date | null;
  finishedAt: Date | null;
  voidReason: string | null;
  completionJobId: string | null;
  completedDocId: string | null;
  completedVersion: number | null;
  documents: EnvelopeDocument[];
  signers: Signer[];
  fields: Field[];
}

export interface StoredEvent {
  seq: number;
  kind: string;
  at: string;
  payload: unknown;
  prevHash: string;
  hash: string;
}

export type SignError = { kind: "not_found" } | { kind: "conflict"; message: string } | { kind: "internal"; message: string };
export type SignResult<T> = { ok: true; value: T } | { ok: false; error: SignError };

export interface DraftInput {
  title: string;
  message: string | null;
  orderMode: OrderMode;
  expiresAt: Date | null;
  reminderDays: number | null;
  documents: Array<{ docId: Uuid; name: string }>;
  signers: Array<{ id: Uuid; name: string; email: string; order: number }>;
  fields: Array<{ id: Uuid; signerId: Uuid; docId: Uuid; page: number; rect: [number, number, number, number]; kind: FieldKind; required: boolean; label: string | null }>;
}

export interface SignRepository {
  createDraft(input: DraftInput & { id: Uuid; orgId: Uuid; createdBy: string; senderEmail?: string | null; now: Date }): Promise<SignResult<Envelope>>;
  /** Replace a draft's content (documents, signers, fields); only while it is a draft. */
  updateDraft(orgId: Uuid, envelopeId: Uuid, input: DraftInput, now: Date): Promise<SignResult<Envelope>>;
  getEnvelope(orgId: Uuid, envelopeId: Uuid): Promise<SignResult<Envelope>>;
  listEnvelopes(orgId: Uuid, opts: { status?: EnvelopeStatus; limit: number; before?: Date }): Promise<SignResult<Envelope[]>>;
  /** draft → sent: freeze each document's version, hash and page count. */
  send(orgId: Uuid, envelopeId: Uuid, frozen: Array<{ docId: Uuid; version: number; sha256: string; pageCount: number }>, now: Date): Promise<SignResult<Envelope>>;
  /** Give a signer a fresh link (their turn, or a resend): pending/notified/viewed → notified. */
  issueToken(orgId: Uuid, signerId: Uuid, tokenHash: string, expiresAt: Date, now: Date): Promise<SignResult<Signer>>;
  /** The public route's lookup, across orgs; only a live link of a sent envelope. */
  signerByToken(tokenHash: string, now: Date): Promise<SignResult<{ signer: Signer; envelope: Envelope }>>;
  markViewed(orgId: Uuid, signerId: Uuid, now: Date): Promise<SignResult<Signer>>;
  setOtp(orgId: Uuid, signerId: Uuid, otpHash: string, expiresAt: Date): Promise<SignResult<Signer>>;
  /** Check a code; 5 wrong tries end it. Returns whether it matched (and the signer after). */
  checkOtp(orgId: Uuid, signerId: Uuid, otpHash: string, now: Date): Promise<SignResult<{ matched: boolean; signer: Signer }>>;
  /** Fill the signer's fields and mark them signed; only a verified signer whose turn it is. The link is spent. */
  submit(orgId: Uuid, signerId: Uuid, values: Array<{ fieldId: Uuid; value: FieldValue }>, meta: { ip: string | null; userAgent: string | null }, now: Date): Promise<SignResult<Envelope>>;
  decline(orgId: Uuid, signerId: Uuid, reason: string | null, meta: { ip: string | null; userAgent: string | null }, now: Date): Promise<SignResult<Envelope>>;
  void(orgId: Uuid, envelopeId: Uuid, reason: string | null, now: Date): Promise<SignResult<Envelope>>;
  /** sent → completing, once everyone signed. */
  markCompleting(orgId: Uuid, envelopeId: Uuid, jobId: string | null, now: Date): Promise<SignResult<Envelope>>;
  /** completing → completed, with the drive document that holds the signed PDF. */
  complete(orgId: Uuid, envelopeId: Uuid, docId: Uuid, version: number, now: Date): Promise<SignResult<Envelope>>;
  /** Housekeeping, across orgs: sent envelopes past their expiry become expired (links spent). */
  expireDue(now: Date, limit: number): Promise<SignResult<Array<{ orgId: string; envelopeId: string }>>>;
  /** Housekeeping, across orgs: signers with a live link who have not signed and are due a reminder. */
  dueForReminder(now: Date, limit: number): Promise<SignResult<Array<{ signer: Signer; envelope: Envelope }>>>;
  markReminded(orgId: Uuid, signerId: Uuid, now: Date): Promise<SignResult<void>>;
  /** Envelopes stuck in completing (the job never finished), across orgs, for a retry. */
  stuckCompleting(olderThan: Date, limit: number): Promise<SignResult<Envelope[]>>;

  appendEvent(orgId: Uuid, envelopeId: Uuid, event: StoredEvent): Promise<SignResult<void>>;
  lastEvent(orgId: Uuid, envelopeId: Uuid): Promise<SignResult<StoredEvent | null>>;
  listEvents(orgId: Uuid, envelopeId: Uuid): Promise<SignResult<StoredEvent[]>>;
}

const DAY_MS = 86_400_000;
export const OTP_MAX_ATTEMPTS = 5;

const date = (v: unknown) => new Date(v as string);
const dateOrNull = (v: unknown) => (v ? new Date(v as string) : null);
const iso = (d: Date) => d.toISOString();
const fail = (message: string): SignResult<never> => ({ ok: false, error: { kind: "internal", message } });
const conflict = (message: string): SignResult<never> => ({ ok: false, error: { kind: "conflict", message } });
const notFound: SignResult<never> = { ok: false, error: { kind: "not_found" } };
function parse<T>(v: unknown, fallback: T): T {
  try {
    return typeof v === "string" ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

const mapSigner = (r: SqlRow): Signer => ({
  id: r.id as string,
  orgId: r.org_id as string,
  envelopeId: r.envelope_id as string,
  name: r.name as string,
  email: r.email as string,
  order: Number(r.routing_order),
  status: r.status as SignerStatus,
  tokenExpiresAt: r.token_hash ? dateOrNull(r.token_expires_at) : null,
  otpExpiresAt: dateOrNull(r.otp_expires_at),
  otpAttempts: Number(r.otp_attempts ?? 0),
  verifiedAt: dateOrNull(r.verified_at),
  notifiedAt: dateOrNull(r.notified_at),
  viewedAt: dateOrNull(r.viewed_at),
  signedAt: dateOrNull(r.signed_at),
  declinedAt: dateOrNull(r.declined_at),
  declineReason: (r.decline_reason as string | null) ?? null,
  ip: (r.ip as string | null) ?? null,
  userAgent: (r.user_agent as string | null) ?? null,
  remindedAt: dateOrNull(r.reminded_at),
});

const mapField = (r: SqlRow): Field => ({
  id: r.id as string,
  signerId: r.signer_id as string,
  docId: r.doc_id as string,
  page: Number(r.page),
  rect: parse<[number, number, number, number]>(r.rect_json, [0, 0, 0, 0]),
  kind: r.kind as FieldKind,
  required: Number(r.required) === 1,
  label: (r.label as string | null) ?? null,
  value: parse<FieldValue | null>(r.value_json, null),
  filledAt: dateOrNull(r.filled_at),
});

const mapDocument = (r: SqlRow): EnvelopeDocument => ({
  docId: r.doc_id as string,
  position: Number(r.position),
  name: r.name as string,
  version: r.version == null ? null : Number(r.version),
  sha256: (r.sha256 as string | null) ?? null,
  pageCount: r.page_count == null ? null : Number(r.page_count),
});

const mapEvent = (r: SqlRow): StoredEvent => ({
  seq: Number(r.seq),
  kind: r.kind as string,
  at: r.at as string,
  payload: parse<unknown>(r.payload_json, null),
  prevHash: r.prev_hash as string,
  hash: r.hash as string,
});

function mapEnvelope(r: SqlRow, documents: EnvelopeDocument[], signers: Signer[], fields: Field[]): Envelope {
  return {
    id: r.id as string,
    orgId: r.org_id as string,
    title: r.title as string,
    message: (r.message as string | null) ?? null,
    status: r.status as EnvelopeStatus,
    orderMode: r.order_mode as OrderMode,
    expiresAt: dateOrNull(r.expires_at),
    reminderDays: r.reminder_days == null ? null : Number(r.reminder_days),
    createdBy: r.created_by as string,
    senderEmail: (r.sender_email as string | null) ?? null,
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
    sentAt: dateOrNull(r.sent_at),
    finishedAt: dateOrNull(r.finished_at),
    voidReason: (r.void_reason as string | null) ?? null,
    completionJobId: (r.completion_job_id as string | null) ?? null,
    completedDocId: (r.completed_doc_id as string | null) ?? null,
    completedVersion: r.completed_version == null ? null : Number(r.completed_version),
    documents,
    signers,
    fields,
  };
}

/** The lowest routing order among signers who have not signed: whose turn it is in a sequential envelope. */
export function currentWave(signers: readonly Pick<Signer, "order" | "status">[]): number | null {
  const waiting = signers.filter((s) => s.status !== "signed").map((s) => s.order);
  return waiting.length ? Math.min(...waiting) : null;
}

export function createSignRepository(executor: SqlExecutor): SignRepository {
  const rows = async (text: string, params: unknown[]) => (await executor.execute(text, params)).rows;
  const one = async (text: string, params: unknown[]) => (await rows(text, params))[0];

  async function full(orgId: string, row: SqlRow): Promise<Envelope> {
    const [docs, signers, fields] = await Promise.all([
      rows(`SELECT * FROM sign_envelope_documents WHERE org_id = $1 AND envelope_id = $2 ORDER BY position`, [orgId, row.id]),
      rows(`SELECT * FROM sign_signers WHERE org_id = $1 AND envelope_id = $2 ORDER BY routing_order, rowid`, [orgId, row.id]),
      rows(`SELECT * FROM sign_fields WHERE org_id = $1 AND envelope_id = $2 ORDER BY rowid`, [orgId, row.id]),
    ]);
    return mapEnvelope(row, docs.map(mapDocument), signers.map(mapSigner), fields.map(mapField));
  }
  async function envelope(orgId: string, envelopeId: string): Promise<Envelope | null> {
    const r = await one(`SELECT * FROM sign_envelopes WHERE org_id = $1 AND id = $2`, [orgId, envelopeId]);
    return r ? full(orgId, r) : null;
  }
  async function signer(orgId: string, signerId: string): Promise<Signer | null> {
    const r = await one(`SELECT * FROM sign_signers WHERE org_id = $1 AND id = $2`, [orgId, signerId]);
    return r ? mapSigner(r) : null;
  }

  function contentStatements(orgId: Uuid, envelopeId: Uuid, input: DraftInput) {
    const out: Array<{ text: string; params: unknown[] }> = [];
    input.documents.forEach((d, i) =>
      out.push({ text: `INSERT INTO sign_envelope_documents (org_id, envelope_id, doc_id, position, name) VALUES ($1, $2, $3, $4, $5)`, params: [orgId, envelopeId, d.docId, i, d.name] }),
    );
    for (const s of input.signers) {
      out.push({ text: `INSERT INTO sign_signers (id, org_id, envelope_id, name, email, routing_order) VALUES ($1, $2, $3, $4, $5, $6)`, params: [s.id, orgId, envelopeId, s.name, s.email.toLowerCase(), s.order] });
    }
    for (const f of input.fields) {
      out.push({
        text: `INSERT INTO sign_fields (id, org_id, envelope_id, signer_id, doc_id, page, rect_json, kind, required, label) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        params: [f.id, orgId, envelopeId, f.signerId, f.docId, f.page, JSON.stringify(f.rect), f.kind, f.required ? 1 : 0, f.label],
      });
    }
    return out;
  }

  return {
    async createDraft(input) {
      try {
        await executeBatch(executor, [
          {
            text: `INSERT INTO sign_envelopes (id, org_id, title, message, order_mode, expires_at, reminder_days, created_by, sender_email, created_at, updated_at)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
            params: [input.id, input.orgId, input.title, input.message, input.orderMode, input.expiresAt ? iso(input.expiresAt) : null, input.reminderDays, input.createdBy, input.senderEmail ?? null, iso(input.now)],
          },
          ...contentStatements(input.orgId, input.id, input),
        ]);
        const e = await envelope(input.orgId, input.id);
        return e ? { ok: true, value: e } : fail("envelope vanished");
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },

    async updateDraft(orgId, envelopeId, input, now) {
      try {
        const cur = await envelope(orgId, envelopeId);
        if (!cur) return notFound;
        if (cur.status !== "draft") return conflict("only a draft can be changed");
        // The deletes and inserts are conditional on the envelope still being a draft, in one batch.
        const isDraft = `EXISTS (SELECT 1 FROM sign_envelopes WHERE org_id = $1 AND id = $2 AND status = 'draft')`;
        await executeBatch(executor, [
          { text: `DELETE FROM sign_fields WHERE org_id = $1 AND envelope_id = $2 AND ${isDraft}`, params: [orgId, envelopeId] },
          { text: `DELETE FROM sign_signers WHERE org_id = $1 AND envelope_id = $2 AND ${isDraft}`, params: [orgId, envelopeId] },
          { text: `DELETE FROM sign_envelope_documents WHERE org_id = $1 AND envelope_id = $2 AND ${isDraft}`, params: [orgId, envelopeId] },
          {
            text: `UPDATE sign_envelopes SET title = $3, message = $4, order_mode = $5, expires_at = $6, reminder_days = $7, updated_at = $8
                   WHERE org_id = $1 AND id = $2 AND status = 'draft'`,
            params: [orgId, envelopeId, input.title, input.message, input.orderMode, input.expiresAt ? iso(input.expiresAt) : null, input.reminderDays, iso(now)],
          },
          ...contentStatements(orgId, envelopeId, input),
        ]);
        const e = await envelope(orgId, envelopeId);
        return e ? { ok: true, value: e } : notFound;
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },

    async getEnvelope(orgId, envelopeId) {
      try {
        const e = await envelope(orgId, envelopeId);
        return e ? { ok: true, value: e } : notFound;
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },

    async listEnvelopes(orgId, opts) {
      try {
        const params: unknown[] = [orgId];
        let where = `org_id = $1`;
        if (opts.status) {
          params.push(opts.status);
          where += ` AND status = $${params.length}`;
        }
        if (opts.before) {
          params.push(iso(opts.before));
          where += ` AND created_at < $${params.length}`;
        }
        params.push(Math.max(1, Math.min(100, opts.limit)));
        const rs = await rows(`SELECT * FROM sign_envelopes WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`, params);
        return { ok: true, value: await Promise.all(rs.map((r) => full(orgId, r))) };
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },

    async send(orgId, envelopeId, frozen, now) {
      try {
        const cur = await envelope(orgId, envelopeId);
        if (!cur) return notFound;
        if (cur.status !== "draft") return conflict("this envelope was already sent");
        const results = await executeBatch(executor, [
          { text: `UPDATE sign_envelopes SET status = 'sent', sent_at = $3, updated_at = $3 WHERE org_id = $1 AND id = $2 AND status = 'draft' RETURNING id`, params: [orgId, envelopeId, iso(now)] },
          ...frozen.map((f) => ({
            text: `UPDATE sign_envelope_documents SET version = $4, sha256 = $5, page_count = $6 WHERE org_id = $1 AND envelope_id = $2 AND doc_id = $3`,
            params: [orgId, envelopeId, f.docId, f.version, f.sha256, f.pageCount],
          })),
        ]);
        if (!results[0]?.rows.length) return conflict("this envelope was already sent");
        const e = await envelope(orgId, envelopeId);
        return e ? { ok: true, value: e } : notFound;
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },

    async issueToken(orgId, signerId, tokenHash, expiresAt, now) {
      try {
        const r = await one(
          `UPDATE sign_signers SET token_hash = $3, token_expires_at = $4, status = CASE WHEN status = 'viewed' THEN 'viewed' ELSE 'notified' END,
                  notified_at = $5, otp_hash = NULL, otp_expires_at = NULL, otp_attempts = 0
           WHERE org_id = $1 AND id = $2 AND status IN ('pending', 'notified', 'viewed')
             AND EXISTS (SELECT 1 FROM sign_envelopes e WHERE e.org_id = $1 AND e.id = sign_signers.envelope_id AND e.status = 'sent')
           RETURNING *`,
          [orgId, signerId, tokenHash, iso(expiresAt), iso(now)],
        );
        return r ? { ok: true, value: mapSigner(r) } : notFound;
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },

    async signerByToken(tokenHash, now) {
      try {
        const r = await one(`SELECT * FROM sign_signers WHERE token_hash = $1`, [tokenHash]);
        if (!r) return notFound;
        const s = mapSigner(r);
        if (!s.tokenExpiresAt || s.tokenExpiresAt <= now) return notFound;
        const e = await envelope(s.orgId, s.envelopeId);
        if (!e || e.status !== "sent") return notFound;
        return { ok: true, value: { signer: s, envelope: e } };
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },

    async markViewed(orgId, signerId, now) {
      try {
        const r = await one(
          `UPDATE sign_signers SET status = CASE WHEN status = 'notified' THEN 'viewed' ELSE status END, viewed_at = COALESCE(viewed_at, $3)
           WHERE org_id = $1 AND id = $2 RETURNING *`,
          [orgId, signerId, iso(now)],
        );
        return r ? { ok: true, value: mapSigner(r) } : notFound;
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },

    async setOtp(orgId, signerId, otpHash, expiresAt) {
      try {
        const r = await one(
          `UPDATE sign_signers SET otp_hash = $3, otp_expires_at = $4, otp_attempts = 0
           WHERE org_id = $1 AND id = $2 AND status IN ('notified', 'viewed') AND token_hash IS NOT NULL RETURNING *`,
          [orgId, signerId, otpHash, iso(expiresAt)],
        );
        return r ? { ok: true, value: mapSigner(r) } : notFound;
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },

    async checkOtp(orgId, signerId, otpHash, now) {
      try {
        // A match: verified, the code spent. Otherwise count the try; the fifth wrong one spends it.
        const hit = await one(
          `UPDATE sign_signers SET verified_at = $4, otp_hash = NULL, otp_expires_at = NULL, otp_attempts = 0
           WHERE org_id = $1 AND id = $2 AND otp_hash = $3 AND otp_expires_at > $4 AND otp_attempts < ${OTP_MAX_ATTEMPTS} RETURNING *`,
          [orgId, signerId, otpHash, iso(now)],
        );
        if (hit) return { ok: true, value: { matched: true, signer: mapSigner(hit) } };
        const miss = await one(
          `UPDATE sign_signers SET otp_attempts = otp_attempts + 1,
                  otp_hash = CASE WHEN otp_attempts + 1 >= ${OTP_MAX_ATTEMPTS} THEN NULL ELSE otp_hash END
           WHERE org_id = $1 AND id = $2 AND otp_hash IS NOT NULL RETURNING *`,
          [orgId, signerId],
        );
        const s = miss ? mapSigner(miss) : await signer(orgId, signerId);
        return s ? { ok: true, value: { matched: false, signer: s } } : notFound;
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },

    async submit(orgId, signerId, values, meta, now) {
      try {
        const s = await signer(orgId, signerId);
        if (!s) return notFound;
        const e = await envelope(orgId, s.envelopeId);
        if (!e || e.status !== "sent") return conflict("this envelope is not open for signing");
        if (!["notified", "viewed"].includes(s.status) || !s.verifiedAt) return conflict("not verified, or already done");
        if (e.orderMode === "sequential" && currentWave(e.signers) !== s.order) return conflict("it is not this signer's turn yet");
        const mine = new Map(e.fields.filter((f) => f.signerId === signerId).map((f) => [f.id, f]));
        for (const v of values) if (!mine.has(v.fieldId)) return conflict("a field that is not this signer's");
        const given = new Set<string>(values.map((v) => v.fieldId));
        for (const f of mine.values()) if (f.required && !given.has(f.id)) return conflict(`required field ${f.id} is empty`);
        // The field writes only apply while the signer may still sign; the signer update spends the link.
        const canSign = `EXISTS (SELECT 1 FROM sign_signers WHERE org_id = $1 AND id = $2 AND status IN ('notified', 'viewed') AND verified_at IS NOT NULL)`;
        const results = await executeBatch(executor, [
          ...values.map((v) => ({
            text: `UPDATE sign_fields SET value_json = $4, filled_at = $5 WHERE org_id = $1 AND signer_id = $2 AND id = $3 AND ${canSign}`,
            params: [orgId, signerId, v.fieldId, JSON.stringify(v.value), iso(now)],
          })),
          {
            text: `UPDATE sign_signers SET status = 'signed', signed_at = $3, token_hash = NULL, token_expires_at = NULL, ip = $4, user_agent = $5
                   WHERE org_id = $1 AND id = $2 AND status IN ('notified', 'viewed') AND verified_at IS NOT NULL RETURNING id`,
            params: [orgId, signerId, iso(now), meta.ip, meta.userAgent?.slice(0, 500) ?? null],
          },
        ]);
        if (!results[results.length - 1]?.rows.length) return conflict("not verified, or already done");
        const after = await envelope(orgId, s.envelopeId);
        return after ? { ok: true, value: after } : notFound;
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },

    async decline(orgId, signerId, reason, meta, now) {
      try {
        const s = await signer(orgId, signerId);
        if (!s) return notFound;
        const results = await executeBatch(executor, [
          {
            text: `UPDATE sign_signers SET status = 'declined', declined_at = $3, decline_reason = $4, token_hash = NULL, token_expires_at = NULL, ip = $5, user_agent = $6
                   WHERE org_id = $1 AND id = $2 AND status IN ('notified', 'viewed')
                     AND EXISTS (SELECT 1 FROM sign_envelopes e WHERE e.org_id = $1 AND e.id = sign_signers.envelope_id AND e.status = 'sent') RETURNING id`,
            params: [orgId, signerId, iso(now), reason?.slice(0, 1000) ?? null, meta.ip, meta.userAgent?.slice(0, 500) ?? null],
          },
          {
            text: `UPDATE sign_envelopes SET status = 'declined', finished_at = $3, updated_at = $3
                   WHERE org_id = $1 AND id = $2 AND status = 'sent' AND EXISTS (SELECT 1 FROM sign_signers WHERE org_id = $1 AND envelope_id = $2 AND status = 'declined')`,
            params: [orgId, s.envelopeId, iso(now)],
          },
          { text: `UPDATE sign_signers SET token_hash = NULL, token_expires_at = NULL WHERE org_id = $1 AND envelope_id = $2 AND EXISTS (SELECT 1 FROM sign_envelopes WHERE org_id = $1 AND id = $2 AND status = 'declined')`, params: [orgId, s.envelopeId] },
        ]);
        if (!results[0]?.rows.length) return conflict("this signer cannot decline now");
        const e = await envelope(orgId, s.envelopeId);
        return e ? { ok: true, value: e } : notFound;
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },

    async void(orgId, envelopeId, reason, now) {
      try {
        const results = await executeBatch(executor, [
          {
            text: `UPDATE sign_envelopes SET status = 'voided', void_reason = $3, finished_at = $4, updated_at = $4 WHERE org_id = $1 AND id = $2 AND status IN ('draft', 'sent') RETURNING id`,
            params: [orgId, envelopeId, reason?.slice(0, 1000) ?? null, iso(now)],
          },
          { text: `UPDATE sign_signers SET token_hash = NULL, token_expires_at = NULL WHERE org_id = $1 AND envelope_id = $2`, params: [orgId, envelopeId] },
        ]);
        if (!results[0]?.rows.length) return (await envelope(orgId, envelopeId)) ? conflict("only a draft or a sent envelope can be voided") : notFound;
        const e = await envelope(orgId, envelopeId);
        return e ? { ok: true, value: e } : notFound;
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },

    async markCompleting(orgId, envelopeId, jobId, now) {
      try {
        const r = await one(
          `UPDATE sign_envelopes SET status = 'completing', completion_job_id = COALESCE($3, completion_job_id), updated_at = $4
           WHERE org_id = $1 AND id = $2 AND status IN ('sent', 'completing')
             AND NOT EXISTS (SELECT 1 FROM sign_signers WHERE org_id = $1 AND envelope_id = $2 AND status <> 'signed') RETURNING id`,
          [orgId, envelopeId, jobId, iso(now)],
        );
        if (!r) return (await envelope(orgId, envelopeId)) ? conflict("not everyone has signed") : notFound;
        const e = await envelope(orgId, envelopeId);
        return e ? { ok: true, value: e } : notFound;
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },

    async complete(orgId, envelopeId, docId, version, now) {
      try {
        const r = await one(
          `UPDATE sign_envelopes SET status = 'completed', completed_doc_id = $3, completed_version = $4, finished_at = $5, updated_at = $5
           WHERE org_id = $1 AND id = $2 AND status = 'completing' RETURNING id`,
          [orgId, envelopeId, docId, version, iso(now)],
        );
        if (!r) return (await envelope(orgId, envelopeId)) ? conflict("this envelope is not completing") : notFound;
        const e = await envelope(orgId, envelopeId);
        return e ? { ok: true, value: e } : notFound;
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },

    async expireDue(now, limit) {
      try {
        const due = await rows(`SELECT org_id, id FROM sign_envelopes WHERE status = 'sent' AND expires_at IS NOT NULL AND expires_at <= $1 ORDER BY expires_at LIMIT $2`, [iso(now), limit]);
        const done: Array<{ orgId: string; envelopeId: string }> = [];
        for (const d of due) {
          const results = await executeBatch(executor, [
            { text: `UPDATE sign_envelopes SET status = 'expired', finished_at = $3, updated_at = $3 WHERE org_id = $1 AND id = $2 AND status = 'sent' RETURNING id`, params: [d.org_id, d.id, iso(now)] },
            { text: `UPDATE sign_signers SET token_hash = NULL, token_expires_at = NULL WHERE org_id = $1 AND envelope_id = $2`, params: [d.org_id, d.id] },
          ]);
          if (results[0]?.rows.length) done.push({ orgId: d.org_id as string, envelopeId: d.id as string });
        }
        return { ok: true, value: done };
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },

    async dueForReminder(now, limit) {
      try {
        // Live link, not signed, envelope sent with reminders on, last reminded (or notified) reminder_days ago.
        const rs = await rows(
          `SELECT s.*, e.reminder_days AS e_reminder_days FROM sign_signers s JOIN sign_envelopes e ON e.org_id = s.org_id AND e.id = s.envelope_id
           WHERE e.status = 'sent' AND e.reminder_days IS NOT NULL AND s.token_hash IS NOT NULL AND s.status IN ('notified', 'viewed')
           ORDER BY COALESCE(s.reminded_at, s.notified_at) LIMIT $1`,
          [limit * 4],
        );
        const out: Array<{ signer: Signer; envelope: Envelope }> = [];
        for (const r of rs) {
          const last = dateOrNull(r.reminded_at) ?? dateOrNull(r.notified_at);
          if (!last || now.getTime() - last.getTime() < Number(r.e_reminder_days) * DAY_MS) continue;
          const e = await envelope(r.org_id as string, r.envelope_id as string);
          if (e) out.push({ signer: mapSigner(r), envelope: e });
          if (out.length >= limit) break;
        }
        return { ok: true, value: out };
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },

    async markReminded(orgId, signerId, now) {
      try {
        await executor.execute(`UPDATE sign_signers SET reminded_at = $3 WHERE org_id = $1 AND id = $2`, [orgId, signerId, iso(now)]);
        return { ok: true, value: undefined };
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },

    async stuckCompleting(olderThan, limit) {
      try {
        const rs = await rows(`SELECT * FROM sign_envelopes WHERE status = 'completing' AND updated_at <= $1 ORDER BY updated_at LIMIT $2`, [iso(olderThan), limit]);
        return { ok: true, value: await Promise.all(rs.map((r) => full(r.org_id as string, r))) };
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },

    async appendEvent(orgId, envelopeId, event) {
      try {
        // The envelope must be this org's; the primary key (envelope_id, seq) refuses a second
        // writer of the same seq, who then retries from the new last event.
        const r = await one(
          `INSERT INTO sign_events (org_id, envelope_id, seq, kind, payload_json, at, prev_hash, hash)
           SELECT $1, $2, $3, $4, $5, $6, $7, $8 WHERE EXISTS (SELECT 1 FROM sign_envelopes WHERE org_id = $1 AND id = $2) RETURNING seq`,
          [orgId, envelopeId, event.seq, event.kind, JSON.stringify(event.payload), event.at, event.prevHash, event.hash],
        );
        return r ? { ok: true, value: undefined } : notFound;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return /UNIQUE|PRIMARY KEY|constraint/i.test(message) ? conflict("another event took this place in the chain") : fail(message);
      }
    },

    async lastEvent(orgId, envelopeId) {
      try {
        const r = await one(`SELECT * FROM sign_events WHERE org_id = $1 AND envelope_id = $2 ORDER BY seq DESC LIMIT 1`, [orgId, envelopeId]);
        return { ok: true, value: r ? mapEvent(r) : null };
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },

    async listEvents(orgId, envelopeId) {
      try {
        const rs = await rows(`SELECT * FROM sign_events WHERE org_id = $1 AND envelope_id = $2 ORDER BY seq`, [orgId, envelopeId]);
        return { ok: true, value: rs.map(mapEvent) };
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  };
}
