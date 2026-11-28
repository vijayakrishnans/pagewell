// The drive client's sharing methods (PW3): URL shapes for folders and documents, bodies,
// Shared with me, and share links with their password header.

import { describe, expect, it, vi } from "vitest";

import { Pagewell } from "../index.js";
import { NotFoundError } from "../errors.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DOC = "doc_dddddddddddddddddddddddddddddddd";
const FLD = "fld_ffffffffffffffffffffffffffffffff";
const TOKEN = "A".repeat(43);

function client(respond: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return respond(String(input), init ?? {});
  }) as unknown as typeof globalThis.fetch;
  return { pw: new Pagewell({ baseUrl: "https://api.example.com", auth: { kind: "bearer", token: "t" }, fetch }), calls };
}
const ok = (data: unknown, status = 200) => new Response(JSON.stringify({ data, meta: { requestId: "r" } }), { status, headers: { "content-type": "application/json" } });
const base = `https://api.example.com/v1/organizations/${ORG}`;

describe("FilesClient sharing", () => {
  it("shares a folder by email and a document with a member, and removes a grant", async () => {
    const { pw, calls } = client((_u, init) => (init.method === "DELETE" ? new Response(null, { status: 204 }) : ok({ grant: { id: "grt_1" } }, 201)));
    await pw.files.share(ORG, "folder", FLD, { email: "guest@example.com", role: "viewer", message: "hi" });
    await pw.files.share(ORG, "document", DOC, { userId: "usr_1", role: "editor" });
    await pw.files.unshare(ORG, "folder", FLD, "grt_1");
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      `POST ${base}/folders/${FLD}/grants`,
      `POST ${base}/documents/${DOC}/grants`,
      `DELETE ${base}/folders/${FLD}/grants/grt_1`,
    ]);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ email: "guest@example.com", role: "viewer", message: "hi" });
  });

  it("reads access, the access list, links, guests and activity", async () => {
    const { pw, calls } = client((url) => {
      if (url.endsWith("/access")) return ok({ access: { role: "editor", actions: ["files.read"], principal: "member" } });
      if (url.endsWith("/links")) return ok({ links: [{ id: "lnk_1" }] });
      return ok({ grants: [], links: [], access: null, guests: [], entries: [], nextCursor: null });
    });
    expect((await pw.files.access(ORG, "document", DOC)).role).toBe("editor");
    await pw.files.accessList(ORG, "folder", FLD);
    expect(await pw.files.listLinks(ORG, "document", DOC)).toEqual([{ id: "lnk_1" }]);
    await pw.files.listGuests(ORG);
    await pw.files.activity(ORG, DOC, { limit: 20, cursor: "c1" });
    expect(calls.map((c) => c.url)).toEqual([
      `${base}/documents/${DOC}/access`,
      `${base}/folders/${FLD}/grants`,
      `${base}/documents/${DOC}/links`,
      `${base}/guests`,
      `${base}/documents/${DOC}/activity?cursor=c1&limit=20`,
    ]);
  });

  it("creates and revokes a link, and removes a guest", async () => {
    const { pw, calls } = client((_u, init) => (init.method === "DELETE" ? new Response(null, { status: 204 }) : ok({ link: { id: "lnk_1" }, token: TOKEN }, 201)));
    const created = await pw.files.createLink(ORG, "document", DOC, { role: "viewer", password: "correct horse", allowDownload: false });
    expect(created.token).toBe(TOKEN);
    await pw.files.revokeLink(ORG, "document", DOC, "lnk_1");
    await pw.files.removeGuest(ORG, "gst_1");
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([`POST ${base}/documents/${DOC}/links`, `DELETE ${base}/documents/${DOC}/links/lnk_1`, `DELETE ${base}/guests/gst_1`]);
  });

  it("lists what is shared with me", async () => {
    const { pw, calls } = client(() => ok({ items: [] }));
    await pw.files.sharedWithMe();
    expect(calls[0]!.url).toBe("https://api.example.com/v1/me/shared");
  });

  it("opens a share link with its password in the header, never in the URL", async () => {
    const { pw, calls } = client((url) => (url.includes("/content") ? new Response("%PDF-1.7", { headers: { "content-type": "application/pdf" } }) : ok({ link: { role: "viewer" }, folder: null, document: null, folders: [], documents: [] })));
    await pw.files.openLink(TOKEN, { password: "correct horse", folderId: FLD });
    const pdf = await pw.files.linkContent(TOKEN, { password: "correct horse", documentId: DOC });
    expect(await pdf.text()).toBe("%PDF-1.7");
    expect(calls.map((c) => c.url)).toEqual([`https://api.example.com/v1/l/${TOKEN}?folderId=${FLD}`, `https://api.example.com/v1/l/${TOKEN}/content?documentId=${DOC}`]);
    for (const c of calls) {
      expect(new Headers(c.init.headers).get("x-pagewell-link-password")).toBe("correct horse");
      expect(c.url).not.toContain("horse");
    }
  });

  it("a dead link is a NotFoundError", async () => {
    const { pw } = client(() => new Response(JSON.stringify({ error: { code: "not_found", message: "Not found", details: {} } }), { status: 404, headers: { "content-type": "application/json" } }));
    await expect(pw.files.openLink(TOKEN)).rejects.toBeInstanceOf(NotFoundError);
  });
});
