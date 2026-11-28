import type { PublicDocument } from "@saas/contracts/files";
import type { PublicAccess } from "@saas/contracts/sharing";
import type { Env } from "./env.js";

// The drive, as a person (sign-worker, PW6). Every read and write goes to files-worker with that
// person's actor headers, so the drive's own checks, quotas and audit apply. The sender's access
// decides what they may send; the completion acts as the envelope's sender too.

export interface Actor {
  subjectId: string;
  subjectType: string;
  email: string | null;
}

export class DriveError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface Drive {
  document(docId: string): Promise<PublicDocument>;
  access(docId: string): Promise<PublicAccess | null>;
  /** One version's bytes (the current one when `version` is null), and which version it was. */
  content(docId: string, version: number | null): Promise<{ bytes: Uint8Array<ArrayBuffer>; version: number }>;
  /** A new document in the sender's drive (top level). */
  upload(name: string, bytes: Uint8Array<ArrayBuffer>, pageCount: number | null): Promise<{ id: string; version: number }>;
  /** A view-and-download link to a document, for signers (who have no account). */
  link(docId: string, expiresAt: Date): Promise<string>;
}

export function driveFor(env: Env, orgPublicId: string, actor: Actor, requestId: string): Drive {
  const base = `https://files.internal/v1/organizations/${orgPublicId}`;
  const call = async (path: string, init: RequestInit = {}) => {
    if (!env.FILES_WORKER) throw new DriveError(503, "internal_error", "The drive is not bound");
    const headers = new Headers(init.headers);
    headers.set("x-request-id", requestId);
    headers.set("x-actor-subject-id", actor.subjectId);
    headers.set("x-actor-subject-type", actor.subjectType);
    if (actor.email) headers.set("x-actor-email", actor.email);
    const res = await env.FILES_WORKER.fetch(base + path, { ...init, headers });
    if (!res.ok) {
      let code = "error";
      let message = `The drive answered ${res.status}`;
      try {
        const body = (await res.json()) as { error?: { code?: string; message?: string } };
        code = body.error?.code ?? code;
        message = body.error?.message ?? message;
      } catch {
        /* not JSON */
      }
      throw new DriveError(res.status, code, message);
    }
    return res;
  };
  return {
    async document(docId) {
      return ((await (await call(`/documents/${docId}`)).json()) as { data: { document: PublicDocument } }).data.document;
    },
    async access(docId) {
      try {
        return ((await (await call(`/documents/${docId}/access`)).json()) as { data: { access: PublicAccess } }).data.access;
      } catch (e) {
        if (e instanceof DriveError && e.status === 404) return null;
        throw e;
      }
    },
    async content(docId, version) {
      const res = await call(`/documents/${docId}/content${version ? `?version=${version}` : ""}`);
      const v = Number(res.headers.get("x-pagewell-version"));
      return { bytes: new Uint8Array(await res.arrayBuffer()), version: Number.isInteger(v) && v > 0 ? v : (version ?? 1) };
    },
    async upload(name, bytes, pageCount) {
      const res = await call(`/documents?name=${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { "content-type": "application/pdf", ...(pageCount ? { "x-pagewell-page-count": String(pageCount) } : {}) },
        body: bytes,
      });
      const data = ((await res.json()) as { data: { document: PublicDocument } }).data;
      return { id: data.document.id, version: data.document.currentVersion };
    },
    async link(docId, expiresAt) {
      const res = await call(`/documents/${docId}/links`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "viewer", allowDownload: true, expiresAt: expiresAt.toISOString() }),
      });
      return ((await res.json()) as { data: { token: string } }).data.token;
    },
  };
}
