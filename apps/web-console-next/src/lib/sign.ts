/**
 * E-sign in the console (PW6): pure helpers for the Request signatures dialog and the Envelopes
 * page. Dependency-free so they are unit-testable (tests/web-console-next/src/sign.test.ts).
 *
 * Fields are placed by choosing a page and a spot on it (the console does not draw pages yet):
 * the spots are rectangles on a US Letter page (612 × 792 pt) measured from its top-left, which
 * also land sensibly on A4.
 */

import type { EnvelopeInput, EnvelopeStatus, FieldKind, PublicEnvelope, Rect, SignerStatus } from "@saas/contracts/sign";

export type Spot = "bottom-left" | "bottom-right" | "middle-left" | "top-right";
export const SPOTS: ReadonlyArray<{ id: Spot; label: string }> = [
  { id: "bottom-left", label: "Bottom left" },
  { id: "bottom-right", label: "Bottom right" },
  { id: "middle-left", label: "Middle left" },
  { id: "top-right", label: "Top right" },
];

const SIG_W = 200;
const SIG_H = 40;

/** The rectangle for a signature (or initials, smaller) at a spot. */
export function spotRect(spot: Spot, kind: "signature" | "initials" | "date"): Rect {
  const w = kind === "initials" ? 70 : kind === "date" ? 120 : SIG_W;
  const h = kind === "date" ? 20 : kind === "initials" ? 30 : SIG_H;
  const x = spot.endsWith("left") ? 72 : 612 - 72 - SIG_W;
  const y = spot === "top-right" ? 72 : spot === "middle-left" ? 396 : 792 - 72 - SIG_H * 2;
  // A date goes under its signature.
  return kind === "date" ? [x, y + SIG_H + 6, w, h] : [x, y, w, h];
}

export interface SignerRow {
  name: string;
  email: string;
  page: number;
  spot: Spot;
  withDate: boolean;
}

export interface RequestForm {
  title: string;
  message: string;
  orderMode: "parallel" | "sequential";
  reminderDays: number | null;
  signers: SignerRow[];
}

const EMAIL = /^[^\s@]{1,200}@[^\s@]{1,200}\.[^\s@]{1,63}$/;

/** The envelope to create for one document, or what is wrong with the form. */
export function envelopeRequest(documentId: string, pageCount: number | null, form: RequestForm): { ok: true; request: EnvelopeInput } | { ok: false; error: string } {
  const title = form.title.trim();
  if (!title || title.length > 200) return { ok: false, error: "Give it a title (up to 200 characters)." };
  if (form.message.length > 2000) return { ok: false, error: "The message can be up to 2000 characters." };
  if (form.signers.length === 0) return { ok: false, error: "Add at least one signer." };
  if (form.signers.length > 20) return { ok: false, error: "At most 20 signers." };
  const seen = new Set<string>();
  const signers: EnvelopeInput["signers"] = [];
  const fields: EnvelopeInput["fields"] = [];
  for (const [i, s] of form.signers.entries()) {
    const name = s.name.trim();
    const email = s.email.trim().toLowerCase();
    if (!name) return { ok: false, error: `Signer ${i + 1} needs a name.` };
    if (!EMAIL.test(email)) return { ok: false, error: `Signer ${i + 1} needs an email address.` };
    if (seen.has(email)) return { ok: false, error: `${email} is listed twice.` };
    seen.add(email);
    const max = pageCount ?? 10_000;
    if (!Number.isInteger(s.page) || s.page < 1 || s.page > max) return { ok: false, error: `Signer ${i + 1}: a page from 1 to ${max}.` };
    const key = `s${i + 1}`;
    signers.push({ key, name, email, order: form.orderMode === "sequential" ? i + 1 : 1 });
    fields.push({ signer: key, documentId, page: s.page, rect: spotRect(s.spot, "signature"), kind: "signature" as FieldKind });
    if (s.withDate) fields.push({ signer: key, documentId, page: s.page, rect: spotRect(s.spot, "date"), kind: "date" as FieldKind });
  }
  return {
    ok: true,
    request: { title, message: form.message.trim() || null, orderMode: form.orderMode, reminderDays: form.reminderDays, documents: [{ documentId }], signers, fields },
  };
}

export const STATUS_LABEL: Record<EnvelopeStatus, string> = {
  draft: "Draft",
  sent: "Waiting for signatures",
  completing: "Sealing the signed PDF",
  completed: "Completed",
  declined: "Declined",
  expired: "Expired",
  voided: "Voided",
};

export const SIGNER_LABEL: Record<SignerStatus, string> = {
  pending: "Not their turn yet",
  notified: "Emailed",
  viewed: "Opened",
  signed: "Signed",
  declined: "Declined",
};

/** "1 of 2 signed". */
export function progress(e: Pick<PublicEnvelope, "signers">): string {
  return `${e.signers.filter((s) => s.status === "signed").length} of ${e.signers.length} signed`;
}

/** What the sender may do now. */
export function actions(e: Pick<PublicEnvelope, "status">): { resend: boolean; void: boolean; open: boolean } {
  return { resend: e.status === "sent", void: e.status === "sent" || e.status === "draft", open: e.status === "completed" };
}
