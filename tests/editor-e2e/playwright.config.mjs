// The editor in three engines, driven through the bridge API (window.pagewell).
// EDITOR_URL points at a deployed editor (stage); otherwise wrangler dev serves apps/editor-web,
// which must be built first (pnpm --filter @pagewell/editor-web build).
import { defineConfig, devices } from "@playwright/test";

const external = process.env.EDITOR_URL || undefined;
const port = 8799;

export default defineConfig({
  testDir: "./specs",
  timeout: 180_000,
  expect: { timeout: 60_000 },
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["list"], ["json", { outputFile: "results.json" }], ["html", { open: "never" }]],
  use: {
    baseURL: external ?? `http://127.0.0.1:${port}`,
    viewport: { width: 1280, height: 800 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], launchOptions: { executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] } } },
    // CI runners have no GPU, and headless Firefox finds no GL driver there; the editor draws
    // with WebGL2. In CI Firefox runs headed under Xvfb on Mesa's software GL (llvmpipe), with
    // its blocklist overridden (editor-e2e.yml installs both).
    {
      name: "firefox",
      use: {
        ...devices["Desktop Firefox"],
        headless: !process.env.FIREFOX_HEADED,
        launchOptions: { firefoxUserPrefs: { "webgl.force-enabled": true, "webgl.disabled": false } },
      },
    },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: external
    ? undefined
    : {
        // The drive tests fake the API and the console on these two origins (specs/cloud.spec.mjs).
        command: `pnpm --dir ../../apps/editor-web exec wrangler dev --port ${port} --ip 127.0.0.1 --var API_ORIGIN:http://api.test --var CONSOLE_ORIGIN:http://console.test`,
        url: `http://127.0.0.1:${port}/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
