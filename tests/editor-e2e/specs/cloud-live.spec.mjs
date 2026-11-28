// The editor on a deployed drive (PW2), with nothing faked but the console page that hands over
// the session: a throwaway user signs in on stage (the code comes back inline there), uploads a
// generated PDF through the real API, and the real editor opens, edits and saves it.
//
// Runs only against a deployed editor whose API returns login codes inline:
//   EDITOR_URL=https://pagewell-editor-web-stage.<sub>.workers.dev LIVE_DRIVE=1 pnpm e2e specs/cloud-live.spec.mjs
// The session token stays in this process and in the editor tab; it is never printed.
import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";

import { fixturePdf } from "../../../apps/editor-web/scripts/fixture.mjs";

const external = process.env.EDITOR_URL || "";
const API = external.replace("pagewell-editor-web-", "pagewell-api-edge-").replace(/\/$/, "");
const CONSOLE = external.replace("pagewell-editor-web-", "pagewell-web-console-next-").replace(/\/$/, "");
const sha = (b) => createHash("sha256").update(b).digest("hex");

test.skip(!external || process.env.LIVE_DRIVE !== "1", "needs EDITOR_URL and LIVE_DRIVE=1 (a deployed stage)");

async function call(token, method, path, { body, headers = {}, json } = {}) {
  const h = new Headers(headers);
  if (token) h.set("authorization", `Bearer ${token}`);
  if (json !== undefined) {
    h.set("content-type", "application/json");
    body = JSON.stringify(json);
  }
  return fetch(API + path, { method, headers: h, body });
}
const data = async (res) => (await res.json()).data;

async function signIn(email = `pw-e2e-editor-${Date.now().toString(36)}@example.com`) {
  const s = await data(await call(null, "POST", "/v1/auth/login/start", { json: { email } }));
  expect(s.delivery.mode, "this environment must return login codes inline").toBe("local_debug");
  const done = await data(await call(null, "POST", "/v1/auth/login/complete", { json: { challengeId: s.challengeId, code: s.delivery.code } }));
  const orgs = (await data(await call(done.token, "GET", "/v1/organizations"))).organizations;
  if (orgs.length) return { token: done.token, orgId: orgs[0].id, email };
  // Team profile (PW-18): a new user makes their first org.
  const slug = `live-${Date.now().toString(36)}`;
  const created = await data(await call(done.token, "POST", "/v1/organizations", { json: { name: "Live", slug } }));
  return { token: done.token, orgId: created.organization.id, email };
}

test("the real editor opens a drive document, saves v2, survives a stale save by reloading, and v1 restores", async ({ context, page }) => {
  const { token, orgId } = await signIn();
  const A = `/v1/organizations/${orgId}`;
  const v1 = fixturePdf(5);
  let res = await call(token, "POST", `${A}/documents?name=Generated.pdf`, { body: v1, headers: { "content-type": "application/pdf", "x-pagewell-page-count": "5" } });
  expect(res.status).toBe(201);
  const doc = (await data(res)).document;
  const D = `${A}/documents/${doc.id}`;

  // The console's part, on the console's real origin: open the editor, answer its hello.
  const editorOrigin = new URL(external).origin;
  await context.route(`${CONSOLE}/drive-handoff`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><title>console</title><script>
        const session = { type: "pagewell:session", token: ${JSON.stringify(token)}, apiBase: ${JSON.stringify(API)}, orgId: ${JSON.stringify(orgId)} };
        window.open(${JSON.stringify(`${editorOrigin}/edit/${doc.id}?org=${orgId}`)}, "_blank");
        addEventListener("message", (e) => {
          if (e.origin !== ${JSON.stringify(editorOrigin)} || e.data?.type !== "pagewell:hello") return;
          e.source.postMessage(session, e.origin);
        });
      </script>`,
    }),
  );
  const popup = context.waitForEvent("page");
  await page.goto(`${CONSOLE}/drive-handoff`);
  const editor = await popup;
  await editor.waitForFunction(() => window.pagewell?.cloud, null, { timeout: 150_000 });
  await expect(editor.locator("#status")).toContainText("Generated.pdf — version 1");
  expect(editor.url()).not.toContain(token);

  // Edit and save: version 2 on the drive, with one page fewer.
  await editor.evaluate(() => window.pagewell.automation({ tool: "page_delete", args: { pages: [1] } }));
  await editor.locator("#save").click();
  await expect(editor.locator("#status")).toContainText("Saved version 2");
  const afterSave = (await data(await call(token, "GET", D))).document;
  expect(afterSave.currentVersion).toBe(2);
  expect(afterSave.pageCount).toBe(4);
  res = await call(token, "GET", `${D}/content`);
  const v2 = new Uint8Array(await res.arrayBuffer());
  expect(new TextDecoder("latin1").decode(v2.subarray(0, 5))).toBe("%PDF-");
  expect(sha(v2)).not.toBe(sha(v1));
  await expect.poll(async () => (await call(token, "GET", `${D}/versions/2/thumbnail`)).status, { timeout: 30_000 }).toBe(200);

  // Someone else saves version 3 meanwhile; the editor's next save is stale. Reload takes v3.
  res = await call(token, "POST", `${D}/versions`, { body: fixturePdf(3), headers: { "content-type": "application/pdf", "x-pagewell-base-version": "2" } });
  expect(res.status).toBe(201);
  await editor.evaluate(() => window.pagewell.automation({ tool: "page_rotate", args: { pages: [1], degrees: 90 } }));
  await editor.locator("#save").click();
  await expect(editor.locator("#conflict")).toBeVisible();
  await expect(editor.locator("#conflict-version")).toHaveText("3");
  await editor.locator("#conflict").getByRole("button", { name: /Reload/ }).click();
  await expect(editor.locator("#status")).toContainText("Generated.pdf — version 3");
  expect((await data(await call(token, "GET", D))).document.currentVersion).toBe(3);

  // Restore version 1 (what the console's history does): version 4 holds v1's bytes.
  res = await call(token, "POST", `${D}/versions/1/restore`, { headers: { "x-pagewell-base-version": "3" } });
  expect(res.status).toBe(201);
  res = await call(token, "GET", `${D}/content`);
  expect(res.headers.get("x-pagewell-version")).toBe("4");
  expect(sha(new Uint8Array(await res.arrayBuffer()))).toBe(sha(v1));
});

test("a share link opens the real document in the real viewer, view only; turned off, it stops", async ({ page }) => {
  const { token, orgId } = await signIn();
  const A = `/v1/organizations/${orgId}`;
  let res = await call(token, "POST", `${A}/documents?name=Linked.pdf`, { body: fixturePdf(3), headers: { "content-type": "application/pdf" } });
  expect(res.status).toBe(201);
  const doc = (await data(res)).document;
  res = await call(token, "POST", `${A}/documents/${doc.id}/links`, { json: { role: "viewer", password: "generated pass", allowDownload: true } });
  expect(res.status).toBe(201);
  const { link, token: linkToken } = await data(res);

  await page.goto(`/l/${linkToken}`);
  await expect(page.locator("#link-password")).toBeVisible({ timeout: 150_000 });
  await page.locator("#link-password-input").fill("generated pass");
  await page.locator("#link-password").getByRole("button", { name: "Open" }).click();
  await expect(page.locator("#status")).toContainText("Linked.pdf — view only");
  await expect(page.locator("#save")).toBeHidden();
  await expect(page.locator("#download")).toBeVisible();

  expect((await call(token, "DELETE", `${A}/documents/${doc.id}/links/${link.id}`)).status).toBe(204);
  await page.reload();
  await expect(page.locator("#status")).toContainText("doesn't work any more", { timeout: 150_000 });
});

test("two people in one document: one holds the edit lease, comments arrive live, a save offers a reload, and leaving hands the lease over", async ({ browser }) => {
  const owner = await signIn();
  const second = await signIn(`pw-e2e-second-${Date.now().toString(36)}@example.com`);
  const A = `/v1/organizations/${owner.orgId}`;
  let res = await call(owner.token, "POST", `${A}/documents?name=Together.pdf`, { body: fixturePdf(4), headers: { "content-type": "application/pdf", "x-pagewell-page-count": "4" } });
  expect(res.status).toBe(201);
  const doc = (await data(res)).document;
  // The second person is shared the document as an editor.
  res = await call(owner.token, "POST", `${A}/documents/${doc.id}/grants`, { json: { email: second.email, role: "editor", notify: false } });
  expect(res.status).toBe(201);

  // Each opens the editor in their own browser, with their own session (what the console hands over).
  async function open(who) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript(([apiBase, orgId, token]) => sessionStorage.setItem("pagewell.session", JSON.stringify({ token, apiBase, orgId })), [API, owner.orgId, who.token]);
    await page.goto(`/edit/${doc.id}?org=${owner.orgId}`);
    await page.waitForFunction(() => window.pagewell?.review, null, { timeout: 150_000 });
    return { context, page };
  }
  const one = await open(owner);
  await expect(one.page.locator("#save")).toBeEnabled({ timeout: 20_000 });
  const two = await open(second);

  // The owner holds the lease: the second person reads and comments, and cannot save.
  await expect(two.page.locator("#lease")).toContainText(`${owner.email} is editing`, { timeout: 20_000 });
  await expect(two.page.locator("#save")).toBeDisabled();
  await expect(two.page.locator("#presence")).toContainText(`${owner.email} (editing)`);
  await expect(one.page.locator("#presence")).toContainText(second.email);

  // A comment from the second person appears for the owner without a reload, and a reply comes back.
  await two.page.locator("#comment-page").fill("2");
  await two.page.locator("#comment-body").fill("Generated comment from the second browser.");
  await two.page.locator("#comment-form").getByRole("button", { name: "Comment" }).click();
  const onOwner = one.page.locator(".thread", { hasText: "Generated comment from the second browser." });
  await expect(onOwner).toBeVisible({ timeout: 20_000 });
  await onOwner.locator("textarea").fill("Seen, thanks.");
  await onOwner.getByRole("button", { name: "Reply" }).click();
  await expect(two.page.locator(".thread", { hasText: "Seen, thanks." })).toBeVisible({ timeout: 20_000 });

  // The owner saves; the second person is offered the new version.
  await one.page.evaluate(() => window.pagewell.automation({ tool: "page_delete", args: { pages: [4] } }));
  await one.page.locator("#save").click();
  await expect(one.page.locator("#status")).toContainText("Saved version 2");
  await expect(two.page.locator("#newer-text")).toHaveText(`${owner.email} saved version 2.`, { timeout: 20_000 });

  // The owner leaves: the lease is free, and the second person's editor takes it.
  await one.context.close();
  await expect(two.page.locator("#save")).toBeEnabled({ timeout: 20_000 });
  await expect(two.page.locator("#lease")).toBeHidden();
  await two.context.close();
});
