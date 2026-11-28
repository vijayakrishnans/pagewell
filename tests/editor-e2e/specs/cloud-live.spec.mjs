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

async function signIn() {
  const email = `pw-e2e-editor-${Date.now().toString(36)}@example.com`;
  const s = await data(await call(null, "POST", "/v1/auth/login/start", { json: { email } }));
  expect(s.delivery.mode, "this environment must return login codes inline").toBe("local_debug");
  const done = await data(await call(null, "POST", "/v1/auth/login/complete", { json: { challengeId: s.challengeId, code: s.delivery.code } }));
  const orgs = (await data(await call(done.token, "GET", "/v1/organizations"))).organizations;
  return { token: done.token, orgId: orgs[0].id };
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
