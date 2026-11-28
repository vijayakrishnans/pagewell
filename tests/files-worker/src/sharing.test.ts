import { toPublic } from "@files-worker/ids";
import { fixturePdf, sha256, snapshot, world, type Role, type World } from "./harness.js";

// Sharing through the worker's real router (PW3): the permission matrix at the routes, grants
// with inheritance, guests, share links (password, expiry, revoke on the next request, folder
// subtrees), the audit trail of every share event, Shared with me, and isolation. Generated
// PDFs only.

const ORG_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const ORG_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const A = `/v1/organizations/${toPublic("org", ORG_A)}`;
const B = `/v1/organizations/${toPublic("org", ORG_B)}`;
const ALICE = "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; // owner of A
const BOB = "usr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"; // owner of B
const GUEST = "usr_99999999999999999999999999999999"; // in no org; signs in as guest@example.com
const GUEST_EMAIL = "guest@example.com";

type Json = { data: Record<string, any>; error?: { code: string; message: string; details: Record<string, unknown> } }; // eslint-disable-line @typescript-eslint/no-explicit-any
const json = async (res: Response) => (await res.json()) as Json;

function setup(): World {
  const w = world();
  w.directory.add(ALICE, ORG_A, "owner");
  w.directory.add(BOB, ORG_B, "owner");
  return w;
}

async function folder(w: World, name: string, parentId: string | null = null, base = A, user = ALICE) {
  const res = await w.request("POST", `${base}/folders`, { user, json: { name, parentId } });
  expect(res.status).toBe(201);
  return (await json(res)).data.folder.id as string;
}
async function upload(w: World, name: string, folderId: string | null = null, base = A, user = ALICE) {
  const q = new URLSearchParams({ name, ...(folderId ? { folderId } : {}) });
  const res = await w.request("POST", `${base}/documents?${q}`, { user, body: fixturePdf(2, name), headers: { "content-type": "application/pdf" } });
  expect(res.status).toBe(201);
  return (await json(res)).data.document.id as string;
}
const share = (w: World, kind: "folders" | "documents", id: string, body: Record<string, unknown>, user = ALICE, base = A) =>
  w.request("POST", `${base}/${kind}/${id}/grants`, { user, json: body });
const audit = (w: World) =>
  (w.db.prepare(`SELECT event_type, description FROM events_audit_entries WHERE source = 'files-worker' ORDER BY occurred_at, rowid`).all() as Array<{ event_type: string; description: string }>);
const types = (w: World) => audit(w).map((a) => a.event_type);

// ---------------------------------------------------------------------------------------------

describe("permission matrix at the routes: org role × grant × action", () => {
  type Who = Role | "guest";
  const people: Who[] = ["owner", "admin", "builder", "viewer", "billing_admin", "guest"];
  const grants = [null, { on: "folder", role: "viewer" }, { on: "document", role: "commenter" }, { on: "folder", role: "editor" }] as const;
  const FLOOR: Record<Who, string> = { owner: "editor", admin: "editor", builder: "editor", viewer: "viewer", billing_admin: "none", guest: "none" };
  const RANK: Record<string, number> = { none: 0, viewer: 1, commenter: 2, editor: 3 };

  for (const who of people) {
    for (const g of grants) {
      it(`${who}, ${g ? `${g.role} on the ${g.on}` : "no grant"}`, async () => {
        const w = setup();
        const PERSON = "usr_12121212121212121212121212121212";
        const email = "person@example.com";
        if (who !== "guest") w.directory.add(PERSON, ORG_A, who);
        const f = await folder(w, "Shared");
        const d = await upload(w, "Inside.pdf", f);
        if (g) {
          const target = g.on === "folder" ? ["folders", f] : ["documents", d];
          const body = who === "guest" ? { email, role: g.role } : { userId: PERSON, role: g.role };
          const res = await share(w, target[0] as "folders" | "documents", target[1]!, body);
          // billing_admin is a member with no drive floor: shared with by user id like any member.
          expect(res.status).toBe(201);
        }
        const role = [FLOOR[who], g?.role ?? "none"].reduce((a, b) => (RANK[b]! > RANK[a]! ? b : a));
        const can = { read: RANK[role]! >= 1, comment: RANK[role]! >= 2, write: role === "editor", share: role === "editor" && who !== "guest" };
        const as = { user: PERSON, email };

        const read = await w.request("GET", `${A}/documents/${d}/content`, as);
        expect({ read: read.status }).toEqual({ read: can.read ? 200 : 404 });
        const access = await w.request("GET", `${A}/documents/${d}/access`, as);
        expect(access.status).toBe(can.read ? 200 : 404);
        if (can.read) {
          const actions: string[] = (await json(access)).data.access.actions;
          expect({ comment: actions.includes("files.comment"), share: actions.includes("files.share") }).toEqual({ comment: can.comment, share: can.share });
        }
        const write = await w.request("PATCH", `${A}/documents/${d}`, { ...as, json: { name: "Renamed.pdf" } });
        expect({ write: write.status }).toEqual({ write: can.write ? 200 : 404 });
        const grantsList = await w.request("GET", `${A}/documents/${d}/grants`, as);
        expect({ share: grantsList.status }).toEqual({ share: can.share ? 200 : 404 });
        const del = await w.request("DELETE", `${A}/documents/${d}`, as);
        expect({ delete: del.status }).toEqual({ delete: can.write ? 200 : 404 });
        // The org root is for members with a floor; a grant never opens it.
        const root = await w.request("GET", `${A}/folders`, as);
        expect({ root: root.status }).toEqual({ root: FLOOR[who] !== "none" ? 200 : 404 });
      });
    }
  }
});

describe("grants", () => {
  it("a folder shared with a guest: they open what is in it, see the path from it down, and nothing else", async () => {
    const w = setup();
    const top = await folder(w, "Top");
    const shared = await folder(w, "Shared", top);
    const sub = await folder(w, "Sub", shared);
    const inside = await upload(w, "Inside.pdf", sub);
    const outside = await upload(w, "Outside.pdf", top);

    const res = await share(w, "folders", shared, { email: "Guest@Example.com", name: "A guest", role: "viewer" });
    expect(res.status).toBe(201);
    const grant = (await json(res)).data.grant;
    expect(grant).toMatchObject({ role: "viewer", principal: { kind: "guest", email: GUEST_EMAIL, name: "A guest", verified: false }, inheritedFrom: null });

    const as = { user: GUEST, email: GUEST_EMAIL };
    expect((await w.request("GET", `${A}/documents/${inside}/content`, as)).status).toBe(200);
    expect((await w.request("GET", `${A}/documents/${outside}/content`, as)).status).toBe(404);
    expect((await w.request("GET", `${A}/folders/${top}`, as)).status).toBe(404);
    const listing = (await json(await w.request("GET", `${A}/folders/${sub}`, as))).data;
    expect(listing.breadcrumb.map((b: { name: string }) => b.name)).toEqual(["Shared", "Sub"]);
    // The owner still sees the whole path.
    const full = (await json(await w.request("GET", `${A}/folders/${sub}`, { user: ALICE }))).data;
    expect(full.breadcrumb.map((b: { name: string }) => b.name)).toEqual(["Top", "Shared", "Sub"]);
    // Same email, different case and a different account would not matter: the email is the key.
    expect((await w.request("GET", `${A}/documents/${inside}/content`, { user: GUEST, email: "someone@example.com" })).status).toBe(404);

    // The first visit verified the guest.
    const verified = (await json(await w.request("GET", `${A}/documents/${inside}/grants`, { user: ALICE }))).data.grants;
    expect(verified).toEqual([expect.objectContaining({ principal: expect.objectContaining({ verified: true }), inheritedFrom: { folderId: shared, name: "Shared" } })]);
    expect(types(w)).toContain("guest.verified");
  });

  it("a member's grant widens their floor on that folder only; a non-member's user id is refused", async () => {
    const w = setup();
    const VIEWER = "usr_cccccccccccccccccccccccccccccccc";
    w.directory.add(VIEWER, ORG_A, "viewer");
    const work = await folder(w, "Work");
    const inWork = await upload(w, "In work.pdf", work);
    const elsewhere = await upload(w, "Elsewhere.pdf");
    expect((await share(w, "folders", work, { userId: VIEWER, role: "editor" })).status).toBe(201);
    expect((await w.request("PATCH", `${A}/documents/${inWork}`, { user: VIEWER, json: { name: "Edited.pdf" } })).status).toBe(200);
    expect((await w.request("PATCH", `${A}/documents/${elsewhere}`, { user: VIEWER, json: { name: "No.pdf" } })).status).toBe(404);
    // They may add to the shared folder, not to the root.
    expect((await w.request("POST", `${A}/folders`, { user: VIEWER, json: { name: "New", parentId: work } })).status).toBe(201);
    expect((await w.request("POST", `${A}/folders`, { user: VIEWER, json: { name: "Rootish" } })).status).toBe(404);
    // Moving a document out to the root needs the root.
    expect((await w.request("PATCH", `${A}/documents/${inWork}`, { user: VIEWER, json: { folderId: null } })).status).toBe(404);

    const res = await share(w, "folders", work, { userId: BOB, role: "viewer" });
    expect(res.status).toBe(422);
    expect((await json(res)).error?.details).toEqual({ fields: { userId: [expect.stringContaining("not a member")] } });
    expect((await share(w, "folders", work, { userId: BOB, email: "x@example.com", role: "viewer" })).status).toBe(422);
    expect((await share(w, "folders", work, { email: "x@example.com", role: "owner" })).status).toBe(422);
  });

  it("changing a role updates the grant; an inherited grant is removed on its folder, not below it", async () => {
    const w = setup();
    const f = await folder(w, "F");
    const d = await upload(w, "D.pdf", f);
    const first = (await json(await share(w, "folders", f, { email: GUEST_EMAIL, role: "viewer" }))).data.grant;
    const again = await share(w, "folders", f, { email: GUEST_EMAIL, role: "editor" });
    expect(again.status).toBe(200);
    expect((await json(again)).data.grant).toMatchObject({ id: first.id, role: "editor" });

    expect((await w.request("DELETE", `${A}/documents/${d}/grants/${first.id}`, { user: ALICE })).status).toBe(404);
    expect((await w.request("DELETE", `${A}/folders/${f}/grants/${first.id}`, { user: ALICE })).status).toBe(204);
    expect((await w.request("GET", `${A}/documents/${d}/content`, { user: GUEST, email: GUEST_EMAIL })).status).toBe(404);
    expect(types(w)).toEqual(expect.arrayContaining(["guest.invited", "grant.created", "grant.updated", "grant.deleted"]));
  });

  it("a guest never shares, even as an editor; removing the guest takes all their access at once", async () => {
    const w = setup();
    const f = await folder(w, "F");
    const d = await upload(w, "D.pdf", f);
    await share(w, "folders", f, { email: GUEST_EMAIL, role: "editor" });
    await share(w, "documents", d, { email: GUEST_EMAIL, role: "editor" });
    const as = { user: GUEST, email: GUEST_EMAIL };
    expect((await w.request("PATCH", `${A}/documents/${d}`, { ...as, json: { name: "Guest edit.pdf" } })).status).toBe(200);
    expect((await share(w, "documents", d, { email: "friend@example.com", role: "viewer" }, GUEST)).status).toBe(404);
    expect((await w.request("POST", `${A}/documents/${d}/links`, { ...as, json: { role: "viewer" } })).status).toBe(404);
    expect((await w.request("GET", `${A}/guests`, as)).status).toBe(404);

    const guests = (await json(await w.request("GET", `${A}/guests`, { user: ALICE }))).data.guests;
    expect(guests).toEqual([expect.objectContaining({ email: GUEST_EMAIL })]);
    expect((await w.request("DELETE", `${A}/guests/${guests[0].id}`, { user: ALICE })).status).toBe(204);
    expect((await w.request("GET", `${A}/documents/${d}/content`, as)).status).toBe(404);
    expect(audit(w).find((a) => a.event_type === "guest.removed")?.description).toContain("2 grant(s)");
  });

  it("only the person who started an upload may continue it", async () => {
    const w = setup();
    const ADMIN = "usr_dddddddddddddddddddddddddddddddd";
    w.directory.add(ADMIN, ORG_A, "admin");
    const started = (await json(await w.request("POST", `${A}/uploads`, { user: ALICE, json: { name: "Big.pdf", size: 20 } }))).data.upload;
    const part = await w.request("PUT", `${A}/uploads/${started.id}/parts/1`, { user: ADMIN, body: fixturePdf(1), headers: { "content-type": "application/octet-stream" } });
    expect(part.status).toBe(404);
    expect((await w.request("DELETE", `${A}/uploads/${started.id}`, { user: ADMIN })).status).toBe(404);
    expect((await w.request("DELETE", `${A}/uploads/${started.id}`, { user: ALICE })).status).toBe(204);
  });
});

describe("share invitations", () => {
  it("emails a guest once per share or role change, never a member, and not when asked not to", async () => {
    const w = setup();
    const MEMBER = "usr_cccccccccccccccccccccccccccccccc";
    w.directory.add(MEMBER, ORG_A, "viewer");
    const d = await upload(w, "Invited.pdf");
    await share(w, "documents", d, { email: GUEST_EMAIL, role: "viewer", message: "  For you  " });
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]!.headers["x-internal-actor"]).toBe("files-worker");
    expect(w.sent[0]!.body).toMatchObject({
      category: "product",
      templateKey: "files.shared",
      recipient: { channel: "email", address: GUEST_EMAIL },
      templateData: { role: "viewer", resourceKind: "document", resourceName: "Invited.pdf", message: "For you", openUrl: "https://console.example.com/shared" },
    });
    await share(w, "documents", d, { email: GUEST_EMAIL, role: "viewer" }); // same role again: no news
    expect(w.sent).toHaveLength(1);
    await share(w, "documents", d, { email: GUEST_EMAIL, role: "editor" });
    expect(w.sent).toHaveLength(2);
    await share(w, "documents", d, { userId: MEMBER, role: "editor" });
    await share(w, "documents", d, { email: "quiet@example.com", role: "viewer", notify: false });
    expect(w.sent).toHaveLength(2);
    // The invitation never carries a link token or anything secret.
    expect(JSON.stringify(w.sent)).not.toMatch(/token|password/i);
  });
});

describe("share links", () => {
  const linkPath = (token: string, rest = "") => `/v1/l/${token}${rest}`;

  it("a document link: password, no account, read only; revoking it ends it on the next request", async () => {
    const w = setup();
    const d = await upload(w, "Linked.pdf");
    const expiresAt = new Date(w.now.getTime() + 7 * 86_400_000).toISOString();
    const res = await w.request("POST", `${A}/documents/${d}/links`, { user: ALICE, json: { role: "viewer", password: "correct horse", expiresAt, allowDownload: false } });
    expect(res.status).toBe(201);
    const { link, token } = (await json(res)).data;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(link).toMatchObject({ role: "viewer", hasPassword: true, allowDownload: false, expiresAt });
    expect(JSON.stringify(link)).not.toContain(token);

    expect((await w.request("GET", linkPath(token))).status).toBe(401);
    expect((await json(await w.request("GET", linkPath(token), { headers: { "x-pagewell-link-password": "wrong horse" } }))).error?.code).toBe("link_password_required");
    const pw = { headers: { "x-pagewell-link-password": "correct horse", "cf-connecting-ip": "203.0.113.9", "user-agent": "test-agent" } };
    const opened = await w.request("GET", linkPath(token), pw);
    expect(opened.status).toBe(200);
    const body = (await json(opened)).data;
    expect(body).toMatchObject({ link: { role: "viewer", allowDownload: false }, document: { id: d, name: "Linked.pdf", ownerUserId: "" }, folder: null });
    const pdf = await w.request("GET", linkPath(token, "/content"), pw);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("cache-control")).toBe("no-store");
    expect(pdf.headers.get("x-pagewell-allow-download")).toBe("0");
    // The token reads; it never writes.
    expect((await w.request("POST", linkPath(token, "/content"), pw)).status).toBe(405);

    // Opens are counted with hashes only.
    const opens = w.db.prepare(`SELECT * FROM files_link_opens`).all() as Array<Record<string, string>>;
    expect(opens).toHaveLength(1);
    expect(JSON.stringify(opens)).not.toContain("203.0.113.9");
    expect(JSON.stringify(opens)).not.toContain("test-agent");

    expect((await w.request("DELETE", `${A}/documents/${d}/links/${link.id}`, { user: ALICE })).status).toBe(204);
    expect((await w.request("GET", linkPath(token), pw)).status).toBe(404);
    expect((await w.request("GET", linkPath(token, "/content"), pw)).status).toBe(404);
    expect((await w.request("DELETE", `${A}/documents/${d}/links/${link.id}`, { user: ALICE })).status).toBe(404);

    // The token itself is nowhere in the database.
    const everything = JSON.stringify(["files_links", "files_link_opens", "events_audit_entries", "events_event_log"].map((t) => w.db.prepare(`SELECT * FROM ${t}`).all()));
    expect(everything).not.toContain(token);
    expect(everything).not.toContain("correct horse");
  });

  it("ten wrong passwords lock a link for 15 minutes, whoever guesses; a right one resets the count", async () => {
    const w = setup();
    const d = await upload(w, "Guarded.pdf");
    const { link, token } = (await json(await w.request("POST", `${A}/documents/${d}/links`, { user: ALICE, json: { role: "viewer", password: "correct horse" } }))).data;
    const tryWith = (pw: string, ip = "203.0.113.1") => w.request("GET", linkPath(token), { headers: { "x-pagewell-link-password": pw, "cf-connecting-ip": ip } });
    for (let i = 0; i < 9; i++) expect((await tryWith(`wrong ${i}`, `198.51.100.${i}`)).status).toBe(401);
    expect((await tryWith("correct horse")).status).toBe(200); // resets the count
    for (let i = 0; i < 9; i++) expect((await tryWith(`wrong again ${i}`)).status).toBe(401);
    const locking = await tryWith("tenth wrong");
    expect(locking.status).toBe(429);
    expect(Number(locking.headers.get("retry-after"))).toBe(900);
    // Locked: even the right password waits.
    expect((await tryWith("correct horse")).status).toBe(429);
    expect(types(w)).toContain("link.locked");
    w.now = new Date(w.now.getTime() + 15 * 60_000 + 1000);
    expect((await tryWith("correct horse")).status).toBe(200);
    // A link without a password has nothing to lock.
    const open = (await json(await w.request("POST", `${A}/documents/${d}/links`, { user: ALICE, json: { role: "viewer" } }))).data.token;
    for (let i = 0; i < 12; i++) await w.request("GET", linkPath(open), { headers: { "x-pagewell-link-password": "anything" } });
    expect((await w.request("GET", linkPath(open))).status).toBe(200);
    void link;
  });

  it("an expired link is a 404; an editor link is refused; a link to a trashed document is a 404", async () => {
    const w = setup();
    const d = await upload(w, "Soon.pdf");
    expect((await w.request("POST", `${A}/documents/${d}/links`, { user: ALICE, json: { role: "editor" } })).status).toBe(422);
    expect((await w.request("POST", `${A}/documents/${d}/links`, { user: ALICE, json: { role: "viewer", expiresAt: new Date(w.now.getTime() - 1000).toISOString() } })).status).toBe(422);
    expect((await w.request("POST", `${A}/documents/${d}/links`, { user: ALICE, json: { role: "viewer", password: "short" } })).status).toBe(422);
    const { token } = (await json(await w.request("POST", `${A}/documents/${d}/links`, { user: ALICE, json: { role: "commenter", expiresAt: new Date(w.now.getTime() + 3_600_000).toISOString() } }))).data;
    expect((await w.request("GET", linkPath(token))).status).toBe(200);
    w.now = new Date(w.now.getTime() + 3_600_001);
    expect((await w.request("GET", linkPath(token))).status).toBe(404);

    const d2 = await upload(w, "Trashed.pdf");
    const t2 = (await json(await w.request("POST", `${A}/documents/${d2}/links`, { user: ALICE, json: { role: "viewer" } }))).data.token;
    await w.request("DELETE", `${A}/documents/${d2}`, { user: ALICE });
    expect((await w.request("GET", linkPath(t2))).status).toBe(404);
    expect((await w.request("GET", linkPath(t2, "/content"))).status).toBe(404);
    expect((await w.request("GET", linkPath("A".repeat(43)))).status).toBe(404);
  });

  it("a folder link opens what is under the folder and nothing beside it", async () => {
    const w = setup();
    const top = await folder(w, "Top");
    const linked = await folder(w, "Linked", top);
    const sub = await folder(w, "Sub", linked);
    const inSub = await upload(w, "In sub.pdf", sub);
    const beside = await upload(w, "Beside.pdf", top);
    const { token } = (await json(await w.request("POST", `${A}/folders/${linked}/links`, { user: ALICE, json: { role: "viewer" } }))).data;

    const root = (await json(await w.request("GET", linkPath(token)))).data;
    expect(root.folder).toMatchObject({ id: linked, name: "Linked" });
    expect(root.folders.map((f: { name: string }) => f.name)).toEqual(["Sub"]);
    const subList = (await json(await w.request("GET", linkPath(token, `?folderId=${sub}`)))).data;
    expect(subList.documents.map((d: { name: string; ownerUserId: string }) => [d.name, d.ownerUserId])).toEqual([["In sub.pdf", ""]]);
    expect((await w.request("GET", linkPath(token, `?folderId=${top}`))).status).toBe(404);
    expect((await w.request("GET", linkPath(token, `/content?documentId=${inSub}`))).status).toBe(200);
    expect((await w.request("GET", linkPath(token, `/content?documentId=${beside}`))).status).toBe(404);
    expect((await w.request("GET", linkPath(token, "/content"))).status).toBe(404);
    // Browsing inside does not add an audit entry per folder.
    expect(types(w).filter((t) => t === "link.opened")).toHaveLength(1);
  });
});

describe("the audit trail and activity", () => {
  it("every share event is audited, and a document's activity lists what happened to it, newest first", async () => {
    const w = setup();
    const d = await upload(w, "Tracked.pdf");
    await w.request("POST", `${A}/documents/${d}/versions`, { user: ALICE, body: fixturePdf(3), headers: { "content-type": "application/pdf", "x-pagewell-base-version": "1" } });
    const g = (await json(await share(w, "documents", d, { email: GUEST_EMAIL, role: "commenter" }))).data.grant;
    await share(w, "documents", d, { email: GUEST_EMAIL, role: "viewer" });
    await w.request("GET", `${A}/documents/${d}/content`, { user: GUEST, email: GUEST_EMAIL });
    const { link, token } = (await json(await w.request("POST", `${A}/documents/${d}/links`, { user: ALICE, json: { role: "viewer" } }))).data;
    await w.request("GET", linkPath(token));
    await w.request("DELETE", `${A}/documents/${d}/links/${link.id}`, { user: ALICE });
    await w.request("DELETE", `${A}/documents/${d}/grants/${g.id}`, { user: ALICE });

    expect(types(w)).toEqual([
      "document.created",
      "version.created",
      "guest.invited",
      "grant.created",
      "grant.updated",
      "guest.verified",
      "link.created",
      "link.opened",
      "link.revoked",
      "grant.deleted",
    ]);
    const entries = (await json(await w.request("GET", `${A}/documents/${d}/activity`, { user: ALICE }))).data.entries as Array<{ type: string; description: string }>;
    expect(entries.map((e) => e.type)).toEqual(["grant.deleted", "link.revoked", "link.opened", "link.created", "grant.updated", "grant.created", "version.created", "document.created"]);
    expect(entries[5]!.description).toBe(`Shared document "Tracked.pdf" with ${GUEST_EMAIL} as commenter`);
    // A link opener is attributed to the link, never to a person.
    const opened = w.db.prepare(`SELECT actor_type, actor_id FROM events_audit_entries WHERE event_type = 'link.opened'`).get() as { actor_type: string; actor_id: string };
    expect(opened).toEqual({ actor_type: "share_link", actor_id: link.id });
    // Paging.
    const page = await json(await w.request("GET", `${A}/documents/${d}/activity?limit=3`, { user: ALICE }));
    expect(page.data.entries).toHaveLength(3);
    const next = await json(await w.request("GET", `${A}/documents/${d}/activity?limit=3&cursor=${page.data.nextCursor}`, { user: ALICE }));
    expect(next.data.entries[0].type).toBe("link.created");
    expect((await w.request("GET", `${A}/documents/${d}/activity?cursor=nonsense`, { user: ALICE })).status).toBe(422);
  });
});

function linkPath(token: string, rest = "") {
  return `/v1/l/${token}${rest}`;
}

describe("shared with me", () => {
  it("lists what others shared with the caller, across orgs, by user id or email, once each", async () => {
    const w = setup();
    const dA = await upload(w, "From A.pdf");
    const fB = await folder(w, "From B", null, B, BOB);
    await share(w, "documents", dA, { email: GUEST_EMAIL, role: "commenter" });
    await share(w, "folders", fB, { email: GUEST_EMAIL, role: "editor" }, BOB, B);
    const res = await w.request("GET", "/v1/me/shared", { user: GUEST, email: GUEST_EMAIL });
    const items = (await json(res)).data.items as Array<{ name: string; role: string; orgId: string }>;
    expect(items.map((i) => `${i.name}:${i.role}:${i.orgId === toPublic("org", ORG_A) ? "A" : "B"}`).sort()).toEqual(["From A.pdf:commenter:A", "From B:editor:B"]);
    expect((await json(await w.request("GET", "/v1/me/shared", { user: ALICE }))).data.items).toEqual([]);
    expect((await w.request("GET", "/v1/me/shared")).status).toBe(401);
  });
});

describe("isolation", () => {
  it("sharing routes given another org's ids answer 404 and change nothing; a guest of A is nobody in B", async () => {
    const w = setup();
    const f = await folder(w, "A's");
    const d = await upload(w, "A's.pdf", f);
    const g = (await json(await share(w, "folders", f, { email: GUEST_EMAIL, role: "editor" }))).data.grant;
    const { link } = (await json(await w.request("POST", `${A}/documents/${d}/links`, { user: ALICE, json: { role: "viewer" } }))).data;
    const guestId = (await json(await w.request("GET", `${A}/guests`, { user: ALICE }))).data.guests[0].id;
    const before = snapshot(w);

    const probes: Array<[string, string, unknown?]> = [
      ["GET", `${B}/folders/${f}/grants`],
      ["POST", `${B}/folders/${f}/grants`, { email: "x@example.com", role: "viewer" }],
      ["DELETE", `${B}/folders/${f}/grants/${g.id}`],
      ["GET", `${B}/documents/${d}/links`],
      ["POST", `${B}/documents/${d}/links`, { role: "viewer" }],
      ["DELETE", `${B}/documents/${d}/links/${link.id}`],
      ["GET", `${B}/documents/${d}/access`],
      ["GET", `${B}/documents/${d}/activity`],
      ["DELETE", `${B}/guests/${guestId}`],
      // Bob owns B, not A.
      ["GET", `${A}/folders/${f}/grants`],
      ["DELETE", `${A}/guests/${guestId}`],
      ["DELETE", `${A}/documents/${d}/links/${link.id}`],
    ];
    for (const [method, path, body] of probes) {
      const res = await w.request(method, path, { user: BOB, ...(body ? { json: body } : {}) });
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 404 });
    }
    // The guest's grant in A means nothing in B.
    expect((await w.request("GET", `${B}/folders/${f}`, { user: GUEST, email: GUEST_EMAIL })).status).toBe(404);
    expect((await w.request("GET", `${B}/documents/${d}/content`, { user: GUEST, email: GUEST_EMAIL })).status).toBe(404);
    expect(snapshot(w)).toBe(before);
    expect(sha256(new TextEncoder().encode(before))).toBe(sha256(new TextEncoder().encode(snapshot(w))));
  });
});
