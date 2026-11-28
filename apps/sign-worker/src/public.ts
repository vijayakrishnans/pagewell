import type { PublicEnvelope, PublicField, PublicSigner } from "@saas/contracts/sign";
import type { Envelope, Field, Signer } from "@saas/db/sign";
import { toPublic } from "./ids.js";

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function publicSigner(s: Signer): PublicSigner {
  return {
    id: toPublic("sgn", s.id),
    name: s.name,
    email: s.email,
    order: s.order,
    status: s.status,
    notifiedAt: iso(s.notifiedAt),
    viewedAt: iso(s.viewedAt),
    signedAt: iso(s.signedAt),
    declinedAt: iso(s.declinedAt),
    declineReason: s.declineReason,
  };
}

export function publicField(f: Field): PublicField {
  const v = f.value;
  return {
    id: toPublic("fdl", f.id),
    signerId: toPublic("sgn", f.signerId),
    documentId: toPublic("doc", f.docId),
    page: f.page,
    rect: f.rect,
    kind: f.kind,
    required: f.required,
    label: f.label,
    value: !v ? null : "imageKey" in v ? { image: true } : v,
  };
}

export function publicEnvelope(e: Envelope): PublicEnvelope {
  return {
    id: toPublic("env", e.id),
    title: e.title,
    message: e.message,
    status: e.status,
    orderMode: e.orderMode,
    expiresAt: iso(e.expiresAt),
    reminderDays: e.reminderDays,
    createdAt: e.createdAt.toISOString(),
    sentAt: iso(e.sentAt),
    finishedAt: iso(e.finishedAt),
    voidReason: e.voidReason,
    completedDocumentId: e.completedDocId ? toPublic("doc", e.completedDocId) : null,
    documents: e.documents.map((d) => ({ documentId: toPublic("doc", d.docId), name: d.name, version: d.version, sha256: d.sha256, pageCount: d.pageCount })),
    signers: e.signers.map(publicSigner),
    fields: e.fields.map(publicField),
  };
}
