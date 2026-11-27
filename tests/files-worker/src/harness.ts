// The files worker's real router over: a real SQLite engine with every
// migration applied (D1 is SQLite), an in-memory R2 bucket that keeps
// multipart parts, the real policy engine behind a fake policy-worker, and a
// membership fake that knows who belongs to which org with which role.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { authorize } from "@saas/policy-engine";
import type { AuthorizationRequest, MembershipFact } from "@saas/contracts/policy";
import { D1ApiAdapter } from "@saas/db/runner";
import { route } from "@files-worker/router";
import { sweep } from "@files-worker/cron";
import type { Env } from "@files-worker/env";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(__dirname, "../../..", "packages/db/src/migrations");

export function migratedDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const dir of readdirSync(MIGRATIONS).sort()) {
    const file = join(MIGRATIONS, dir, "up.sql");
    if (!existsSync(file)) continue;
    for (const statement of D1ApiAdapter.splitStatements(readFileSync(file, "utf8"))) db.exec(statement);
  }
  return db;
}

/** D1's binding shape over SQLite; a batch runs synchronously in one transaction, as D1 serializes it. */
export function d1Over(db: DatabaseSync): D1Database {
  const prepare = (query: string) => {
    let bound: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) {
        bound = values;
        return statement;
      },
      run<T>(): T[] {
        return db.prepare(query).all(...(bound as never[])) as T[];
      },
      all<T>() {
        return Promise.resolve({ results: statement.run<T>(), success: true });
      },
    };
    return statement;
  };
  return {
    prepare,
    async batch(statements: Array<{ run(): unknown[] }>) {
      db.exec("BEGIN");
      try {
        const results = statements.map((s) => ({ results: s.run(), success: true }));
        db.exec("COMMIT");
        return results;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  } as unknown as D1Database;
}

interface Stored {
  bytes: Uint8Array;
  contentType?: string | undefined;
}

/** An R2 bucket in memory: objects, list by prefix, and multipart uploads with their parts. */
export class MemoryBucket {
  objects = new Map<string, Stored>();
  uploads = new Map<string, { key: string; parts: Map<number, Uint8Array>; contentType?: string | undefined }>();
  private seq = 0;

  private static async bytesOf(value: unknown): Promise<Uint8Array> {
    if (value instanceof Uint8Array) return new Uint8Array(value);
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (typeof value === "string") return new TextEncoder().encode(value);
    return new Uint8Array(await new Response(value as BodyInit).arrayBuffer());
  }

  private object(key: string, s: Stored) {
    return {
      key,
      size: s.bytes.byteLength,
      httpMetadata: { contentType: s.contentType },
      body: new Response(s.bytes).body!,
      arrayBuffer: async () => s.bytes.slice().buffer,
    };
  }

  async put(key: string, value: unknown, options?: { httpMetadata?: { contentType?: string } }) {
    const bytes = await MemoryBucket.bytesOf(value);
    this.objects.set(key, { bytes, contentType: options?.httpMetadata?.contentType });
    return { key, size: bytes.byteLength };
  }
  async get(key: string) {
    const s = this.objects.get(key);
    return s ? this.object(key, s) : null;
  }
  async head(key: string) {
    const s = this.objects.get(key);
    return s ? { key, size: s.bytes.byteLength } : null;
  }
  async delete(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.objects.delete(k);
  }
  async list(options: { prefix?: string; cursor?: string }) {
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(options.prefix ?? "")).sort();
    return { objects: keys.map((key) => ({ key })), truncated: false, cursor: undefined };
  }
  async createMultipartUpload(key: string, options?: { httpMetadata?: { contentType?: string } }) {
    const uploadId = `mpu-${++this.seq}`;
    this.uploads.set(uploadId, { key, parts: new Map(), contentType: options?.httpMetadata?.contentType });
    return this.resumeMultipartUpload(key, uploadId);
  }
  resumeMultipartUpload(key: string, uploadId: string) {
    const bucket = this;
    return {
      key,
      uploadId,
      async uploadPart(partNumber: number, value: unknown) {
        const u = bucket.uploads.get(uploadId);
        if (!u || u.key !== key) throw new Error("NoSuchUpload");
        u.parts.set(partNumber, await MemoryBucket.bytesOf(value));
        return { partNumber, etag: `etag-${uploadId}-${partNumber}` };
      },
      async complete(parts: Array<{ partNumber: number; etag: string }>) {
        const u = bucket.uploads.get(uploadId);
        if (!u || u.key !== key) throw new Error("NoSuchUpload");
        const chunks = [...parts].sort((a, b) => a.partNumber - b.partNumber).map((p) => {
          const c = u.parts.get(p.partNumber);
          if (!c || p.etag !== `etag-${uploadId}-${p.partNumber}`) throw new Error("InvalidPart");
          return c;
        });
        const total = chunks.reduce((n, c) => n + c.byteLength, 0);
        const bytes = new Uint8Array(total);
        let at = 0;
        for (const c of chunks) {
          bytes.set(c, at);
          at += c.byteLength;
        }
        bucket.objects.set(key, { bytes, contentType: u.contentType });
        bucket.uploads.delete(uploadId);
        return { key, size: total };
      },
      async abort() {
        bucket.uploads.delete(uploadId);
      },
    };
  }
}

export type Role = "owner" | "admin" | "builder" | "viewer" | "billing_admin";

/** Who is a member of which org (org UUIDs), with which role. */
export class Directory {
  private roles = new Map<string, Map<string, Role>>();
  add(userId: string, orgId: string, role: Role) {
    if (!this.roles.has(userId)) this.roles.set(userId, new Map());
    this.roles.get(userId)!.set(orgId, role);
  }
  facts(userId: string, orgId: string): MembershipFact[] {
    const role = this.roles.get(userId)?.get(orgId);
    return role ? [{ kind: "role_assignment", role, scope: { kind: "organization", orgId } } as MembershipFact] : [];
  }
}

const fetcher = (handler: (body: unknown) => unknown): Fetcher =>
  ({
    async fetch(_url: string, init?: RequestInit) {
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : null;
      return Response.json({ data: handler(body) });
    },
  }) as unknown as Fetcher;

/** Billing's entitlement seam: a key set here answers with that limit; anything else is not configured. */
export function billing(limits: Record<string, number | null> = {}): Fetcher {
  return fetcher((body) => {
    const { orgId, entitlementKey } = body as { orgId: string; entitlementKey: string };
    if (!(entitlementKey in limits)) return { allowed: false, orgId, entitlementKey, reason: "not_configured" };
    return { allowed: true, orgId, entitlementKey, valueType: "quantity", limitValue: limits[entitlementKey], source: "plan", subscriptionId: null };
  });
}

export interface World {
  db: DatabaseSync;
  bucket: MemoryBucket;
  directory: Directory;
  env: Env;
  now: Date;
  request(method: string, path: string, init?: { user?: string; body?: BodyInit | null; headers?: Record<string, string>; json?: unknown }): Promise<Response>;
  sweep(at: Date): ReturnType<typeof sweep>;
}

export function world(limits: Record<string, number | null> = {}): World {
  const db = migratedDatabase();
  const bucket = new MemoryBucket();
  const directory = new Directory();
  const env: Env = {
    ENVIRONMENT: "test",
    PLATFORM_DB: d1Over(db),
    FILES_BUCKET: bucket as unknown as R2Bucket,
    MEMBERSHIP_WORKER: fetcher((body) => {
      const { subject, orgId } = body as { subject: { id: string }; orgId: string };
      return { memberships: directory.facts(subject.id, orgId) };
    }),
    POLICY_WORKER: fetcher((body) => authorize(body as AuthorizationRequest)),
    BILLING_WORKER: billing(limits),
  };
  const w: World = {
    db,
    bucket,
    directory,
    env,
    now: new Date("2026-11-01T10:00:00.000Z"),
    async request(method, path, init = {}) {
      const headers: Record<string, string> = { ...(init.headers ?? {}) };
      if (init.user) {
        headers["x-actor-subject-id"] = init.user;
        headers["x-actor-subject-type"] = "user";
      }
      let body = init.body ?? null;
      if (init.json !== undefined) {
        body = JSON.stringify(init.json);
        headers["content-type"] = "application/json";
      }
      if (body instanceof Uint8Array) headers["content-length"] ??= String(body.byteLength);
      const res = await route(new Request(`http://files-worker${path}`, { method, headers, body }), env, w.now);
      return res;
    },
    sweep: (at) => sweep(env, at),
  };
  return w;
}

/** A generated PDF of `pages` pages: valid structure, and it says it is not a real document. */
export function fixturePdf(pages = 1, tag = ""): Uint8Array {
  const objects: string[] = [];
  const kids = Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(" ");
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (let i = 0; i < pages; i++) {
    const text = `BT /F1 18 Tf 72 720 Td (Generated page ${i + 1}. Nothing here is a real document. ${tag}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
  }
  let out = "%PDF-1.7\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Every row of the drive's tables and every R2 key, for "nothing changed" assertions. */
export function snapshot(w: World): string {
  const tables = ["files_folders", "files_documents", "files_versions", "files_uploads"].map((t) => w.db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all());
  const objects = [...w.bucket.objects.entries()].map(([k, v]) => [k, sha256(v.bytes)]).sort();
  return JSON.stringify({ tables, objects, uploads: [...w.bucket.uploads.keys()].sort() });
}
