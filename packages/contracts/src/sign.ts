// Pagewell e-sign (PW6): the public shapes of envelopes, signers, fields, the evidence log and
// the public signing route. A simple electronic signature with an audit trail; no claim of an
// advanced or qualified signature.

export type EnvelopeStatus = "draft" | "sent" | "completing" | "completed" | "declined" | "expired" | "voided";
export type OrderMode = "parallel" | "sequential";
export type SignerStatus = "pending" | "notified" | "viewed" | "signed" | "declined";
export type FieldKind = "signature" | "initials" | "date" | "text" | "checkbox";
/** [x, y, w, h] in points from the page's top-left. */
export type Rect = [number, number, number, number];

export const SIGN_LIMITS = {
  documents: 10,
  signers: 20,
  fieldsPerEnvelope: 200,
  titleChars: 200,
  messageChars: 2000,
  textValueChars: 500,
  /** A drawn signature, as PNG. */
  signatureImageBytes: 512 * 1024,
  /** How long a signing link lives (renewed by a resend or a reminder). */
  linkTtlDays: 14,
  /** How long an email code lives. */
  otpTtlMinutes: 10,
  otpMaxAttempts: 5,
} as const;

export interface PublicEnvelopeDocument {
  documentId: string;
  name: string;
  /** Frozen when sent. */
  version: number | null;
  sha256: string | null;
  pageCount: number | null;
}

export interface PublicSigner {
  id: string;
  name: string;
  email: string;
  order: number;
  status: SignerStatus;
  notifiedAt: string | null;
  viewedAt: string | null;
  signedAt: string | null;
  declinedAt: string | null;
  declineReason: string | null;
}

export interface PublicField {
  id: string;
  signerId: string;
  documentId: string;
  page: number;
  rect: Rect;
  kind: FieldKind;
  required: boolean;
  label: string | null;
  /** Shown to the sender only once filled; a drawn signature shows as `{ image: true }`. */
  value: { text: string } | { checked: boolean } | { image: true } | null;
}

export interface PublicEnvelope {
  id: string;
  title: string;
  message: string | null;
  status: EnvelopeStatus;
  orderMode: OrderMode;
  expiresAt: string | null;
  reminderDays: number | null;
  createdAt: string;
  sentAt: string | null;
  finishedAt: string | null;
  voidReason: string | null;
  /** The drive document that holds the signed PDF, once completed. */
  completedDocumentId: string | null;
  documents: PublicEnvelopeDocument[];
  signers: PublicSigner[];
  fields: PublicField[];
}

export interface EnvelopeInput {
  title: string;
  message?: string | null;
  orderMode?: OrderMode;
  expiresAt?: string | null;
  reminderDays?: number | null;
  documents: Array<{ documentId: string }>;
  /** `key` names a signer for the fields below (any string, unique in the request). */
  signers: Array<{ key: string; name: string; email: string; order?: number }>;
  fields: Array<{ signer: string; documentId: string; page: number; rect: Rect; kind: FieldKind; required?: boolean; label?: string | null }>;
}

export interface EnvelopeResponse {
  envelope: PublicEnvelope;
}
export interface ListEnvelopesResponse {
  envelopes: PublicEnvelope[];
  nextCursor: string | null;
}

export interface PublicEvidenceEvent {
  seq: number;
  kind: string;
  at: string;
  payload: unknown;
  prevHash: string;
  hash: string;
}
export interface EvidenceResponse {
  events: PublicEvidenceEvent[];
  verdict: { ok: true; head: string; length: number } | { ok: false; brokenAt: number; reason: string };
}

// ---- The public signing route (/v1/s/{token}); no account ----

/** What a signer sees: only their own fields, and nothing about the other signers but names and status. */
export interface SigningSession {
  envelope: { title: string; message: string | null; from: string | null; orderMode: OrderMode; expiresAt: string | null };
  signer: { name: string; email: string; status: SignerStatus; verified: boolean };
  /** Is it this signer's turn (always true in parallel). */
  yourTurn: boolean;
  documents: Array<{ documentId: string; name: string; pageCount: number | null }>;
  fields: Array<Omit<PublicField, "signerId" | "value">>;
  others: Array<{ name: string; status: SignerStatus }>;
}

export type FieldValueInput = { fieldId: string; text: string } | { fieldId: string; checked: boolean } | { fieldId: string; imagePng: string /* base64 */ };

export interface SubmitSigningRequest {
  /** Explicit consent to sign electronically. */
  consent: true;
  values: FieldValueInput[];
}
