import type { PublicDocument } from "@saas/contracts/files";
import type { PublicAccess } from "@saas/contracts/sharing";
import type { Env } from "./env.js";

// The drive, as the person a job acts for. Every read and write goes to files-worker with that
// person's actor headers, so the drive's own checks (org role, grants, quotas, version
// conflicts) and its audit apply to a job exactly as to a person in the console.

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
  access(kind: "document" | "folder", id: string): Promise<PublicAccess | null>;
  content(docId: string, version: number): Promise<Uint8Array>;
  saveVersion(docId: string, baseVersion: number, pdf: Uint8Array): Promise<{ id: string; version: number }>;
  createDocument(name: string, folderId: string | null, pdf: Uint8Array): Promise<{ id: string; version: number }>;
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
    async access(kind, id) {
      try {
        const res = await call(`/${kind === "folder" ? "folders" : "documents"}/${id}/access`);
        return ((await res.json()) as { data: { access: PublicAccess } }).data.access;
      } catch (e) {
        if (e instanceof DriveError && e.status === 404) return null;
        throw e;
      }
    },
    async content(docId, version) {
      return new Uint8Array(await (await call(`/documents/${docId}/content?version=${version}`)).arrayBuffer());
    },
    async saveVersion(docId, baseVersion, pdf) {
      const res = await call(`/documents/${docId}/versions`, {
        method: "POST",
        headers: { "content-type": "application/pdf", "x-pagewell-base-version": String(baseVersion), "content-length": String(pdf.byteLength) },
        body: pdf as Uint8Array<ArrayBuffer>,
      });
      const v = ((await res.json()) as { data: { version: { version: number } } }).data.version;
      return { id: docId, version: v.version };
    },
    async createDocument(name, folderId, pdf) {
      const q = new URLSearchParams({ name, ...(folderId ? { folderId } : {}) });
      const res = await call(`/documents?${q}`, { method: "POST", headers: { "content-type": "application/pdf", "content-length": String(pdf.byteLength) }, body: pdf as Uint8Array<ArrayBuffer> });
      const d = ((await res.json()) as { data: { document: { id: string; currentVersion: number } } }).data.document;
      return { id: d.id, version: d.currentVersion };
    },
  };
}
