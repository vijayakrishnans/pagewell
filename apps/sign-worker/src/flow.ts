import { SIGN_LIMITS } from "@saas/contracts/sign";
import { createEventsRepository } from "@saas/db/events";
import { currentWave, type Envelope, type SignRepository, type Signer } from "@saas/db/sign";
import type { Uuid } from "@saas/db/ids";
import { sha256Hex } from "@saas/shared/evidence";
import { audit } from "./audit.js";
import { driveFor } from "./drive.js";
import type { Env } from "./env.js";
import { record } from "./evidence.js";
import { fromPublic, newToken, toPublic } from "./ids.js";
import { notify, signingUrl } from "./notify.js";

// The envelope's life after it is sent (PW6): whose turn it is, giving them links, moving on
// when a wave has signed, and completing once everyone has: the documents as sent, each signer's
// values and a certificate go to the pdf-runner (through pdf-jobs-worker), the sealed PDF comes
// back, becomes a document in the sender's drive, and everyone gets a link to it.

const DAY = 86_400_000;
export const hashToken = (token: string) => sha256Hex(`sign-link:${token}`);
export const hashCode = (signerId: string, code: string) => sha256Hex(`sign-code:${signerId}:${code}`);

export interface FlowCtx {
  env: Env;
  repo: SignRepository;
  orgId: Uuid;
  requestId: string;
  actor: { type: string; id: string };
  now: Date;
  events: ReturnType<typeof createEventsRepository> | null;
}

/** Signers whose turn it is and who have no link yet: everyone (parallel) or the lowest order not signed (sequential). */
export function dueNow(e: Envelope): Signer[] {
  if (e.orderMode === "parallel") return e.signers.filter((s) => s.status === "pending");
  const wave = currentWave(e.signers);
  return e.signers.filter((s) => s.status === "pending" && s.order === wave);
}

/** Give these signers fresh links and email them; returns the links when DEBUG_DELIVERY is on. */
export async function issueLinks(ctx: FlowCtx, e: Envelope, signers: Signer[], reason: "sent" | "turn" | "resend" | "reminder"): Promise<Array<{ signerId: string; url: string | null }>> {
  const debug = ctx.env.DEBUG_DELIVERY === "true";
  const out: Array<{ signerId: string; url: string | null }> = [];
  const expires = new Date(Math.min(ctx.now.getTime() + SIGN_LIMITS.linkTtlDays * DAY, e.expiresAt?.getTime() ?? Infinity));
  for (const s of signers) {
    const token = newToken();
    const issued = await ctx.repo.issueToken(ctx.orgId, s.id as Uuid, await hashToken(token), expires, ctx.now);
    if (!issued.ok) continue;
    await record(ctx.repo, ctx.orgId, e.id as Uuid, "signer.notified", { signer: toPublic("sgn", s.id), email: s.email, reason, linkExpiresAt: expires.toISOString() }, ctx.now);
    const url = signingUrl(ctx.env, token);
    await notify(
      ctx.env,
      { orgId: ctx.orgId, actor: ctx.actor, requestId: ctx.requestId },
      reason === "reminder" ? "sign.reminder" : "sign.requested",
      s.email,
      { title: e.title, message: e.message, from: e.senderEmail, signerName: s.name, signUrl: url, expiresAt: expires.toISOString() },
      [toPublic("sgn", s.id), reason, String(ctx.now.getTime())],
    );
    out.push({ signerId: toPublic("sgn", s.id), url: debug ? url : null });
  }
  return out;
}

/** After a signature: the next wave's links, or the completion when everyone has signed. */
export async function advance(ctx: FlowCtx, e: Envelope): Promise<void> {
  if (e.signers.every((s) => s.status === "signed")) {
    const marked = await ctx.repo.markCompleting(ctx.orgId, e.id as Uuid, null, ctx.now);
    if (!marked.ok) return;
    await record(ctx.repo, ctx.orgId, e.id as Uuid, "envelope.all_signed", { signers: e.signers.length }, ctx.now);
    await complete(ctx, e.id as Uuid);
    return;
  }
  const next = dueNow(e);
  if (next.length) await issueLinks(ctx, e, next, "turn");
}

export type CompletionOutcome = "completed" | "waiting" | "failed";

/** Seal a completing envelope. "waiting": the runner is not there (yet); the cron tries again. */
export async function complete(ctx: FlowCtx, envelopeId: Uuid): Promise<CompletionOutcome> {
  const got = await ctx.repo.getEnvelope(ctx.orgId, envelopeId);
  if (!got.ok || got.value.status !== "completing") return "failed";
  const e = got.value;
  if (!ctx.env.JOBS_WORKER) return "waiting";
  const sender = { subjectId: e.createdBy, subjectType: "user", email: e.senderEmail };
  const orgPublic = toPublic("org", ctx.orgId);
  const drive = driveFor(ctx.env, orgPublic, sender, ctx.requestId);

  // The documents exactly as sent: each must still hash to what was frozen.
  const pdfs: Uint8Array<ArrayBuffer>[] = [];
  for (const d of e.documents) {
    const { bytes } = await drive.content(toPublic("doc", d.docId), d.version);
    if ((await sha256Hex(bytes)) !== d.sha256) {
      await record(ctx.repo, ctx.orgId, envelopeId, "envelope.completion_failed", { reason: "a document no longer matches its hash", document: toPublic("doc", d.docId) }, ctx.now);
      return "failed";
    }
    pdfs.push(bytes);
  }
  const images: Uint8Array<ArrayBuffer>[] = [];
  const fields: Array<Record<string, unknown>> = [];
  for (const f of e.fields) {
    const v = f.value;
    if (!v) continue;
    const base = { doc: e.documents.findIndex((d) => d.docId === f.docId), page: f.page, kind: f.kind, rect: f.rect };
    if ("imageKey" in v) {
      const obj = ctx.env.FILES_BUCKET ? await ctx.env.FILES_BUCKET.get(v.imageKey) : null;
      if (!obj) return "failed";
      images.push(new Uint8Array(await obj.arrayBuffer()));
      fields.push({ ...base, image: images.length - 1 });
    } else if ("checked" in v) fields.push({ ...base, checked: v.checked });
    else fields.push({ ...base, text: v.text });
  }
  const head = await ctx.repo.lastEvent(ctx.orgId, envelopeId);
  if (!head.ok || !head.value) return "failed";
  const options = {
    fields,
    certificate: {
      envelopeId: toPublic("env", e.id),
      title: e.title,
      completedAt: ctx.now.toISOString(),
      documents: e.documents.map((d) => ({ name: d.name, version: d.version, sha256: d.sha256 })),
      signers: e.signers.map((s) => ({ name: s.name, email: s.email, signedAt: s.signedAt?.toISOString() ?? "", ip: s.ip ?? "unknown" })),
      evidenceHead: head.value.hash,
    },
  };
  const parts = [...pdfs, ...images];
  const body = new Uint8Array(parts.reduce((n, b) => n + b.byteLength, 0));
  let at = 0;
  for (const b of parts) {
    body.set(b, at);
    at += b.byteLength;
  }
  let res: Response;
  try {
    res = await ctx.env.JOBS_WORKER.fetch("https://jobs.internal/internal/sign-complete", {
      method: "POST",
      headers: {
        "x-request-id": ctx.requestId,
        "x-pagewell-run": JSON.stringify({ operation: "sign_complete", options, inputs: pdfs.map((b) => b.byteLength), images: images.map((b) => b.byteLength), limits: { pages: 2000, wallSeconds: 300 } }),
      },
      body,
    });
  } catch {
    return "waiting";
  }
  if (res.status === 503) return "waiting";
  if (!res.ok) {
    let code = "runner_failed";
    try {
      code = ((await res.json()) as { error?: { code?: string } }).error?.code ?? code;
    } catch {
      /* not JSON */
    }
    await record(ctx.repo, ctx.orgId, envelopeId, "envelope.completion_failed", { reason: code }, ctx.now);
    return res.status >= 500 ? "waiting" : "failed";
  }
  const manifest = JSON.parse(res.headers.get("x-pagewell-outputs") ?? "[]") as Array<{ name: string; size: number }>;
  const bytes = new Uint8Array(await res.arrayBuffer());
  const pdfEntry = manifest[0];
  if (!pdfEntry || pdfEntry.name !== "result.pdf") return "waiting";
  const signed = bytes.subarray(0, pdfEntry.size);
  const pages = Number(res.headers.get("x-pagewell-pages")) || null;
  const signedHash = await sha256Hex(signed);

  const doc = await drive.upload(`${e.title.replace(/[/\\]/g, "-").slice(0, 200)} (signed).pdf`, signed, pages ? pages + 1 : null);
  const docUuid = fromPublic("doc", doc.id);
  if (!docUuid) return "failed";
  const done = await ctx.repo.complete(ctx.orgId, envelopeId, docUuid, doc.version, ctx.now);
  if (!done.ok) return "failed";
  await record(ctx.repo, ctx.orgId, envelopeId, "envelope.completed", { document: doc.id, sha256: signedHash, pages: pages ? pages + 1 : null }, ctx.now);
  await audit(ctx.events, { orgId: ctx.orgId, actor: ctx.actor, requestId: ctx.requestId, now: ctx.now }, e.documents[0]!.docId, "envelope.completed", `Envelope "${e.title}" completed`, { envelopeId: toPublic("env", e.id), document: doc.id, sha256: signedHash });

  // Everyone gets a link to the sealed PDF (30 days, view and download): signers have no account.
  let downloadUrl: string | null = null;
  try {
    const token = await drive.link(doc.id, new Date(ctx.now.getTime() + 30 * DAY));
    const base = ctx.env.SIGN_URL && /^https:\/\/[^\s/]+$/.test(ctx.env.SIGN_URL) ? ctx.env.SIGN_URL : null;
    downloadUrl = base ? `${base}/l/${token}` : null;
  } catch {
    /* the sender still has the document in their drive */
  }
  const to = new Set([...e.signers.map((s) => s.email), ...(e.senderEmail ? [e.senderEmail] : [])]);
  for (const email of to) {
    await notify(ctx.env, { orgId: ctx.orgId, actor: ctx.actor, requestId: ctx.requestId }, "sign.completed", email, { title: e.title, sha256: signedHash, downloadUrl }, [toPublic("env", e.id), email.replace(/[^A-Za-z0-9._-]/g, "_")]);
  }
  return "completed";
}
