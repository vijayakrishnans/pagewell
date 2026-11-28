// The editor with the drive (PW2): a document opened from the console's handoff, saved as the
// next version with its thumbnail and text, and a stale save resolved by saving a copy.
//
// The drive API and the console are faked with Playwright routes on the origins this editor
// pairs with (locally http://api.test and http://console.test, passed to wrangler dev; on stage
// the real api-edge and console origins, intercepted before they reach the network). Every PDF
// is generated; none is a real document.
import { expect, test } from "@playwright/test";

import { fixturePdf } from "../../../apps/editor-web/scripts/fixture.mjs";

const external = process.env.EDITOR_URL || "";
const API = external ? external.replace("pagewell-editor-web-", "pagewell-api-edge-").replace(/\/$/, "") : "http://api.test";
const CONSOLE = external ? external.replace("pagewell-editor-web-", "pagewell-web-console-next-").replace(/\/$/, "") : "http://console.test";
const ORG = "org_" + "a".repeat(32);
const DOC = "doc_" + "d".repeat(32);
const COPY = "doc_" + "c".repeat(32);
const TOKEN = "sps_ses_generated.for-tests-only";
const base = `${API}/v1/organizations/${ORG}`;

const doc = (id, name, currentVersion) => ({ id, orgId: ORG, folderId: null, name, currentVersion, pageCount: 5, size: 1, ownerUserId: "usr_x", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", deletedAt: null });
// The editor calls the API cross-origin with Authorization and the drive's headers, as api-edge allows.
const cors = (req) => ({
  "access-control-allow-origin": req.headers()["origin"] ?? "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, x-pagewell-base-version, x-pagewell-page-count",
  "access-control-expose-headers": "x-pagewell-version, etag",
});
const json = (req, data, status = 200) => ({ status, contentType: "application/json", headers: cors(req), body: JSON.stringify(data) });

/** A fake drive: one document, versions counted here; `conflictNext` makes the next save stale. */
async function fakeDrive(context) {
  const drive = { version: 1, saves: [], thumbnails: [], texts: [], copies: [], conflictNext: false, auth: new Set() };
  await context.route(`${base}/**`, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors(req) });
    drive.auth.add(req.headers()["authorization"]);
    const url = new URL(req.url());
    const path = url.pathname.replace(`/v1/organizations/${ORG}`, "");
    const pdf = fixturePdf(5);
    if (req.method() === "GET" && (path === `/documents/${DOC}` || path === `/documents/${COPY}`)) {
      const id = path.endsWith(COPY) ? COPY : DOC;
      return route.fulfill(json(req, { data: { document: doc(id, id === COPY ? "Generated (copy).pdf" : "Generated.pdf", drive.version) } }));
    }
    if (req.method() === "GET" && path.endsWith("/content")) {
      return route.fulfill({ status: 200, contentType: "application/pdf", headers: { ...cors(req), "x-pagewell-version": String(drive.version) }, body: pdf });
    }
    if (req.method() === "POST" && path === `/documents/${DOC}/versions`) {
      const baseVersion = Number(req.headers()["x-pagewell-base-version"]);
      if (drive.conflictNext || baseVersion !== drive.version) {
        drive.conflictNext = false;
        drive.version += 1;
        return route.fulfill(json(req, { error: { code: "version_conflict", message: "Someone saved a newer version.", details: { currentVersion: drive.version } } }, 409));
      }
      drive.saves.push({ baseVersion, pages: req.headers()["x-pagewell-page-count"], head: req.postDataBuffer()?.subarray(0, 5).toString("latin1") });
      drive.version += 1;
      return route.fulfill(json(req, { data: { document: doc(DOC, "Generated.pdf", drive.version), version: { version: drive.version } } }, 201));
    }
    if (req.method() === "PUT" && path.endsWith("/thumbnail")) {
      drive.thumbnails.push({ path, type: req.headers()["content-type"], head: req.postDataBuffer()?.subarray(1, 4).toString("latin1") });
      return route.fulfill({ status: 204, headers: cors(req) });
    }
    if (req.method() === "PUT" && path.endsWith("/text")) {
      drive.texts.push(JSON.parse(req.postData() ?? "{}"));
      return route.fulfill({ status: 204, headers: cors(req) });
    }
    if (req.method() === "POST" && path === "/documents") {
      drive.copies.push(url.searchParams.get("name"));
      return route.fulfill(json(req, { data: { document: doc(COPY, url.searchParams.get("name"), 1), version: { version: 1 } } }, 201));
    }
    return route.fulfill(json(req, { error: { code: "not_found", message: "Not found", details: {} } }, 404));
  });
  return drive;
}

/**
 * A stand-in console page that opens the editor and answers its hello, as the real one does.
 * `pushy` also posts the session unasked, every half second (what an impostor would try).
 */
async function fakeConsole(context, { token = TOKEN, from = CONSOLE, pushy = false } = {}) {
  await context.route(`${from}/drive`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><title>console</title><script>
        const EDITOR = ${JSON.stringify(new URL(test.info().project.use.baseURL ?? "http://127.0.0.1:8799").origin)};
        const session = { type: "pagewell:session", token: ${JSON.stringify(token)}, apiBase: ${JSON.stringify(API)}, orgId: "${ORG}" };
        const tab = window.open(EDITOR + "/edit/${DOC}?org=${ORG}", "_blank");
        addEventListener("message", (e) => {
          if (e.origin !== EDITOR || e.data?.type !== "pagewell:hello") return;
          e.source.postMessage(session, EDITOR);
        });
        if (${pushy}) setInterval(() => tab.postMessage(session, EDITOR), 500);
      </script>`,
    }),
  );
}

test("a drive document opens from the console's handoff, saves as the next version with its thumbnail and text", async ({ context, page }) => {
  const drive = await fakeDrive(context);
  await fakeConsole(context);
  const popup = context.waitForEvent("page");
  await page.goto(`${CONSOLE}/drive`);
  const editor = await popup;
  await editor.waitForFunction(() => window.pagewell?.cloud, null, { timeout: 150_000 });
  await expect(editor.locator("#status")).toContainText("Generated.pdf — version 1");
  // The token reached the API in the header, and is in no URL the editor visited.
  expect([...drive.auth]).toEqual([`Bearer ${TOKEN}`]);
  expect(editor.url()).not.toContain(TOKEN);

  await editor.evaluate(() => window.pagewell.automation({ tool: "page_delete", args: { pages: [1] } }));
  await editor.locator("#save").click();
  await expect(editor.locator("#status")).toContainText("Saved version 2");
  expect(drive.saves).toEqual([{ baseVersion: 1, pages: "4", head: "%PDF-" }]);
  await expect.poll(() => drive.texts.length).toBe(1);
  expect(drive.texts[0].pages).toHaveLength(4);
  expect(JSON.stringify(drive.texts[0])).toContain("Nothing here is a real document");
  await expect.poll(() => drive.thumbnails.length).toBe(1);
  expect(drive.thumbnails[0]).toEqual({ path: `/documents/${DOC}/versions/2/thumbnail`, type: "image/png", head: "PNG" });
});

test("a stale save offers a copy, and the copy opens", async ({ context, page }) => {
  const drive = await fakeDrive(context);
  await page.addInitScript(([apiBase, orgId, token]) => sessionStorage.setItem("pagewell.session", JSON.stringify({ token, apiBase, orgId })), [API, ORG, TOKEN]);
  await page.goto(`/edit/${DOC}?org=${ORG}`);
  await page.waitForFunction(() => window.pagewell?.cloud, null, { timeout: 150_000 });
  await page.evaluate(() => window.pagewell.automation({ tool: "page_rotate", args: { pages: [1], degrees: 90 } }));

  drive.conflictNext = true;
  await page.locator("#save").click();
  const dialog = page.locator("#conflict");
  await expect(dialog).toBeVisible();
  await expect(page.locator("#conflict-version")).toHaveText("2");
  await dialog.getByRole("button", { name: "Save as a copy" }).click();
  await page.waitForURL(new RegExp(`/edit/${COPY}\\?org=${ORG}$`));
  expect(drive.copies).toEqual(["Generated (copy).pdf"]);
  await page.waitForFunction(() => window.pagewell?.cloud, null, { timeout: 150_000 });
  await expect(page.locator("#status")).toContainText("Generated (copy).pdf");
});

test("a session from anywhere but the console is ignored", async ({ context, page }) => {
  await fakeDrive(context);
  // The same stand-in page, served from an origin that is not this editor's console.
  await fakeConsole(context, { from: "http://impostor.test", pushy: true });
  const popup = context.waitForEvent("page");
  await page.goto("http://impostor.test/drive");
  const editor = await popup;
  await expect(editor.locator("#status")).toContainText("has no session", { timeout: 150_000 });
  expect(await editor.evaluate(() => sessionStorage.getItem("pagewell.session"))).toBeNull();
});

// ---- Share links (PW3): /l/<token>, view only, no account ----

const LINK = "L".repeat(43);
const linkBase = `${API}/v1/l/${LINK}`;

/** A fake share link: a document (with an optional password) or a folder, or a dead link. */
async function fakeLink(context, { kind = "document", password = null, allowDownload = true, dead = false } = {}) {
  const seen = { passwords: [], urls: [] };
  await context.route(`${linkBase}**`, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors(req) });
    seen.urls.push(req.url());
    seen.passwords.push(req.headers()["x-pagewell-link-password"] ?? null);
    if (dead) return route.fulfill(json(req, { error: { code: "not_found", message: "Not found", details: {} } }, 404));
    if (password && req.headers()["x-pagewell-link-password"] !== password) {
      return route.fulfill(json(req, { error: { code: "link_password_required", message: "This link needs its password", details: {} } }, 401));
    }
    const url = new URL(req.url());
    if (url.pathname.endsWith("/content")) {
      return route.fulfill({ status: 200, contentType: "application/pdf", headers: { ...cors(req), "x-pagewell-allow-download": allowDownload ? "1" : "0" }, body: fixturePdf(3) });
    }
    const link = { role: "viewer", allowDownload, expiresAt: null };
    if (kind === "document") return route.fulfill(json(req, { data: { link, document: doc(DOC, "Shared.pdf", 4), folder: null, folders: [], documents: [] } }));
    const folder = { id: "fld_" + "f".repeat(32), orgId: ORG, parentId: null, name: "Shared folder", createdAt: "", updatedAt: "", deletedAt: null };
    return route.fulfill(json(req, { data: { link, document: null, folder, folders: [], documents: [doc(DOC, "In the folder.pdf", 2)] } }));
  });
  return seen;
}

test("a share link with a password opens view only; the password goes in a header, never the URL", async ({ context, page }) => {
  const seen = await fakeLink(context, { password: "correct horse", allowDownload: false });
  await page.goto(`/l/${LINK}`);
  const dialog = page.locator("#link-password");
  await expect(dialog).toBeVisible({ timeout: 150_000 });
  await page.locator("#link-password-input").fill("correct horse");
  await dialog.getByRole("button", { name: "Open" }).click();
  await expect(page.locator("#status")).toContainText("Shared.pdf — view only");
  await expect(page.locator("#save")).toBeHidden();
  await expect(page.locator("#open-label")).toBeHidden();
  await expect(page.locator("#download")).toBeHidden();
  expect(seen.passwords.at(-1)).toBe("correct horse");
  expect(seen.urls.join(" ")).not.toContain("horse");
  // An edit made here is not saved anywhere.
  await page.evaluate(() => window.pagewell.automation({ tool: "page_delete", args: { pages: [1] } }));
  await page.evaluate(() => window.pagewell.editor.save()).catch(() => undefined);
  expect(seen.urls.every((u) => !u.includes("/versions"))).toBe(true);
});

test("a folder link lists its documents and opens the one chosen, with a download when allowed", async ({ context, page }) => {
  await fakeLink(context, { kind: "folder", allowDownload: true });
  await page.goto(`/l/${LINK}`);
  const dialog = page.locator("#link-folder");
  await expect(dialog).toBeVisible({ timeout: 150_000 });
  await dialog.getByRole("button", { name: "In the folder.pdf" }).click();
  await expect(page.locator("#status")).toContainText("In the folder.pdf — view only");
  await expect(page.locator("#download")).toBeVisible();
});

test("a turned-off link says so", async ({ context, page }) => {
  await fakeLink(context, { dead: true });
  await page.goto(`/l/${LINK}`);
  await expect(page.locator("#status")).toContainText("doesn't work any more", { timeout: 150_000 });
});
