// The drive client (PW2): URL shapes, PDF bodies sent as bytes with the drive's
// headers, a stale save surfacing as ConflictError carrying currentVersion, and
// a large upload sent in parts then completed (or aborted on failure).

import { describe, expect, it, vi } from "vitest";

import { Pagewell } from "../index.js";
import { ConflictError } from "../errors.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DOC = "doc_dddddddddddddddddddddddddddddddd";

interface Call {
  url: string;
  init: RequestInit;
}

function client(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof globalThis.fetch;
  return { pw: new Pagewell({ baseUrl: "https://api.example.com", auth: { kind: "bearer", token: "t" }, fetch }), calls };
}

const ok = (data: unknown, status = 200) => new Response(JSON.stringify({ data, meta: { requestId: "r" } }), { status, headers: { "content-type": "application/json" } });
const header = (c: Call, name: string) => new Headers(c.init.headers).get(name);

describe("FilesClient", () => {
  it("lists the root and a folder", async () => {
    const { pw, calls } = client(() => ok({ folder: null, breadcrumb: [], folders: [], documents: [] }));
    await pw.files.listFolder(ORG);
    await pw.files.listFolder(ORG, "fld_1");
    expect(calls.map((c) => c.url)).toEqual([`https://api.example.com/v1/organizations/${ORG}/folders`, `https://api.example.com/v1/organizations/${ORG}/folders/fld_1`]);
  });

  it("uploads a PDF as bytes with its name, folder and page count", async () => {
    const { pw, calls } = client(() => ok({ document: { id: DOC }, version: { version: 1 } }, 201));
    const pdf = new TextEncoder().encode("%PDF-1.7 generated");
    const r = await pw.files.upload(ORG, { name: "Generated file.pdf", pdf, folderId: "fld_1", pageCount: 3 }, { idempotencyKey: "k1" });
    expect(r.document.id).toBe(DOC);
    const c = calls[0]!;
    expect(c.url).toBe(`https://api.example.com/v1/organizations/${ORG}/documents?name=Generated+file.pdf&folderId=fld_1`);
    expect(c.init.method).toBe("POST");
    expect(header(c, "content-type")).toBe("application/pdf");
    expect(header(c, "x-pagewell-page-count")).toBe("3");
    expect(header(c, "idempotency-key")).toBe("k1");
    expect(header(c, "authorization")).toBe("Bearer t");
    expect(c.init.body).toBe(pdf);
  });

  it("a save sends the base version; a stale one throws ConflictError with currentVersion", async () => {
    const { pw, calls } = client(() =>
      new Response(JSON.stringify({ error: { code: "version_conflict", message: "Someone saved a newer version.", details: { currentVersion: 4 } } }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    );
    const err = await pw.files.save(ORG, DOC, { baseVersion: 3, pdf: new Uint8Array([37, 80, 68, 70]) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).code).toBe("version_conflict");
    expect((err as ConflictError).details).toEqual({ currentVersion: 4 });
    expect(header(calls[0]!, "x-pagewell-base-version")).toBe("3");
    expect(calls[0]!.url).toBe(`https://api.example.com/v1/organizations/${ORG}/documents/${DOC}/versions`);
  });

  it("content returns the raw response for a version", async () => {
    const { pw, calls } = client(() => new Response(new Uint8Array([1, 2]), { headers: { "x-pagewell-version": "2" } }));
    const res = await pw.files.content(ORG, DOC, 2);
    expect(res.headers.get("x-pagewell-version")).toBe("2");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2]));
    expect(calls[0]!.url).toBe(`https://api.example.com/v1/organizations/${ORG}/documents/${DOC}/content?version=2`);
  });

  it("a large upload goes in parts, then completes with the sha256", async () => {
    const { pw, calls } = client((c) => {
      if (c.url.endsWith("/uploads")) return ok({ upload: { id: "upl_1", partSize: 4, expiresAt: "x" } }, 201);
      if (c.url.includes("/parts/")) return ok({ partNumber: Number(c.url.split("/").pop()) });
      return ok({ document: { id: DOC }, version: { version: 1 } }, 201);
    });
    const progress: number[] = [];
    const file = new Blob([new Uint8Array(10)]);
    await pw.files.uploadLarge(ORG, { file, name: "big.pdf", sha256: "a".repeat(64) }, { onProgress: (sent) => progress.push(sent) });
    expect(calls.map((c) => `${c.init.method} ${c.url.replace(`https://api.example.com/v1/organizations/${ORG}`, "")}`)).toEqual([
      "POST /uploads",
      "PUT /uploads/upl_1/parts/1",
      "PUT /uploads/upl_1/parts/2",
      "PUT /uploads/upl_1/parts/3",
      "POST /uploads/upl_1/complete",
    ]);
    expect(progress).toEqual([4, 8, 10]);
    expect(JSON.parse(String(calls[4]!.init.body))).toEqual({ sha256: "a".repeat(64), pageCount: null });
  });

  it("a failed part aborts the upload", async () => {
    const { pw, calls } = client((c) => {
      if (c.url.endsWith("/uploads")) return ok({ upload: { id: "upl_1", partSize: 4, expiresAt: "x" } }, 201);
      if (c.init.method === "DELETE") return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ error: { code: "quota_exceeded", message: "full", details: {} } }), { status: 402, headers: { "content-type": "application/json" } });
    });
    await expect(pw.files.uploadLarge(ORG, { file: new Blob([new Uint8Array(10)]), name: "x.pdf", sha256: "a".repeat(64) })).rejects.toBeTruthy();
    expect(calls.at(-1)!.init.method).toBe("DELETE");
  });
});
