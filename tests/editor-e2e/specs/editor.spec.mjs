import { expect, test } from "@playwright/test";

import { fixturePdf } from "../../../apps/editor-web/scripts/fixture.mjs";

const pages = (reply) => reply.result[0]?.document?.pages;

async function ready(page) {
  await page.waitForFunction(() => window.pagewell?.editor, null, { timeout: 150_000 });
}

test("a local file opens, is edited, undone and saved to disk", async ({ page, browserName }, info) => {
  // The download path everywhere, so the saved file can be read back.
  await page.addInitScript(() => {
    delete window.showSaveFilePicker;
  });
  await page.goto("/edit/local");
  await ready(page);
  await expect(page.locator("#status")).toContainText("Open a PDF");

  const original = fixturePdf(5);
  await page.locator("#open").setInputFiles({ name: "generated.pdf", mimeType: "application/pdf", buffer: original });
  await expect(page.locator("#status")).toContainText("generated.pdf");
  await expect(page.locator("#save")).toBeEnabled();

  const before = await page.evaluate(() => window.pagewell.automation({ tool: "doc_inspect" }));
  expect(pages(before)).toBe(5);
  expect(before.changed).toBe(false);

  const del = await page.evaluate(() => window.pagewell.automation({ tool: "page_delete", args: { pages: [1] } }));
  expect(del.changed).toBe(true);
  expect(del.canUndo).toBe(true);
  await expect(page.locator("#undo")).toBeEnabled();
  expect(pages(await page.evaluate(() => window.pagewell.automation({ tool: "doc_inspect" })))).toBe(4);

  await page.locator("#undo").click();
  await expect(page.locator("#undo")).toBeDisabled();
  await page.waitForTimeout(1000);
  expect(pages(await page.evaluate(() => window.pagewell.automation({ tool: "doc_inspect" })))).toBe(5);

  await page.evaluate(() => window.pagewell.automation({ tool: "page_rotate", args: { pages: [2], degrees: 90 } }));
  const download = page.waitForEvent("download");
  await page.locator("#save").click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("generated.pdf");
  const saved = await file.createReadStream().then(async (s) => Buffer.concat(await s.toArray()));
  expect(saved.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  expect(saved.equals(original)).toBe(false);

  await expect(page.locator(".brand")).toHaveText("Pagewell");
  await page.screenshot({ path: info.outputPath(`editor-${browserName}.png`) });
});

test("tools that would touch files are refused", async ({ page }) => {
  await page.goto("/edit/fixture");
  await ready(page);
  await expect(page.locator("#status")).toContainText("fixture.pdf");
  const refused = await page.evaluate(() =>
    window.pagewell.automation({ tool: "doc_open", args: { path: "/etc/passwd" } }).then(
      () => "allowed",
      (e) => String(e),
    ),
  );
  expect(refused).toMatch(/not available in the browser/);
});

// The budgets: what a first visit downloads and how long until page 1 of the 100-page fixture
// shows (a fresh context: nothing cached). Recorded as annotations; summarize.mjs reports them.
test("the seeded fixture opens with all its pages", async ({ page }, info) => {
  const t0 = Date.now();
  await page.goto("/edit/fixture");
  await ready(page);
  await expect(page.locator("#status")).toContainText("fixture.pdf");
  const firstPage = Date.now() - t0;
  const reply = await page.evaluate(() => window.pagewell.automation({ tool: "doc_inspect" }));
  expect(pages(reply)).toBe(100);
  const transfer = await page.evaluate(() =>
    performance.getEntriesByType("resource").concat(performance.getEntriesByType("navigation")).reduce((n, e) => n + (e.transferSize || 0), 0),
  );
  info.annotations.push({ type: "first-page-ms", description: String(firstPage) });
  info.annotations.push({ type: "first-load-bytes", description: String(transfer) });
  await page.screenshot({ path: info.outputPath(`fixture-${info.project.name}.png`) });
});

test("without WebGL2 the page says why instead of loading forever", async ({ page }) => {
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, ...rest) {
      return kind === "webgl2" ? null : getContext.call(this, kind, ...rest);
    };
  });
  await page.goto("/edit/local");
  await expect(page.locator("#status")).toContainText("WebGL2");
  await expect(page.locator("#status")).toHaveClass(/error/);
});
