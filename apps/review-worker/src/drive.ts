import type { PublicDocument } from "@saas/contracts/files";
import type { PublicAccess } from "@saas/contracts/sharing";
import type { Env } from "./env.js";

// The drive, as the person asking (review-worker, PW5). Every read and write goes to files-worker with that
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
  /** The text stored with a version ({pages:[{page,text}]}), or null when none was stored. */
  text(docId: string, version: number): Promise<unknown | null>;
  /** Share a document with someone by email (a guest unless a member's), as this person. */
  share(docId: string, email: string, role: "commenter" | "viewer", message: string | null): Promise<void>;
  document(docId: string): Promise<PublicDocument>;
  access(kind: "document" | "folder", id: string): Promise<PublicAccess | null>;
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
    async text(docId, version) {
      try {
        return (await (await call(`/documents/${docId}/versions/${version}/text`)).json()) as unknown;
      } catch (e) {
        if (e instanceof DriveError && e.status === 404) return null;
        throw e;
      }
    },
    async share(docId, email, role, message) {
      await call(`/documents/${docId}/grants`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, role, message, notify: true }) });
    },
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
  };
}
