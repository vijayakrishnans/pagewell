import {
  HELLO,
  SESSION,
  SINGLE_REQUEST_MAX,
  editorOrigin,
  editorUrl,
  formatBytes,
  handoffReply,
  pdfFiles,
  purgeIn,
  uploadMode,
  usagePercent,
} from "@web-console-next/lib/drive";
import { DEFAULT_APP_CONFIG, resolveAppConfig } from "@web-console-next/lib/app-config";

// Pagewell's drive in the console (PW-13): the helpers behind the Drive page,
// and the session handoff to the editor tab.

const EDITOR = "https://pagewell-editor-web-stage.vijayakrishnan12994.workers.dev";
const ORG = "org_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DOC = "doc_dddddddddddddddddddddddddddddddd";

describe("the editor's address", () => {
  it("follows the runtime config", () => {
    expect(editorOrigin(DEFAULT_APP_CONFIG, "stage")).toBe(EDITOR);
    const acme = resolveAppConfig({ CONSOLE_EDITOR_WORKER_PREFIX: "acme-editor", CONSOLE_WORKERS_DEV_SUBDOMAIN: "acme" });
    expect(editorOrigin(acme, "prod")).toBe("https://acme-editor-prod.acme.workers.dev");
  });

  it("carries the document and org ids, and nothing secret", () => {
    const url = editorUrl(EDITOR, ORG, DOC);
    expect(url).toBe(`${EDITOR}/edit/${DOC}?org=${ORG}`);
    expect(url).not.toMatch(/token|bearer|sps_/i);
  });
});

describe("the session handoff", () => {
  const tab = { name: "the editor tab" };
  const expected = { origin: EDITOR, window: tab, token: "sps_ses_generated.token", apiBase: "https://api.example", orgId: ORG };

  it("answers the editor tab's hello with the session", () => {
    expect(handoffReply({ origin: EDITOR, source: tab, data: { type: HELLO } }, expected)).toEqual({
      type: SESSION,
      token: "sps_ses_generated.token",
      apiBase: "https://api.example",
      orgId: ORG,
    });
  });

  it.each([
    ["another origin", { origin: "https://evil.example", source: tab, data: { type: HELLO } }],
    ["the prod editor, from a stage console", { origin: EDITOR.replace("-stage", "-prod"), source: tab, data: { type: HELLO } }],
    ["another window on the editor's origin", { origin: EDITOR, source: { name: "some other tab" }, data: { type: HELLO } }],
    ["no source", { origin: EDITOR, source: null, data: { type: HELLO } }],
    ["any other message", { origin: EDITOR, source: tab, data: { type: "pagewell:something" } }],
    ["a string", { origin: EDITOR, source: tab, data: HELLO }],
  ])("ignores %s", (_what, event) => {
    expect(handoffReply(event, expected)).toBeNull();
  });

  it("has nothing to hand over when signed out", () => {
    expect(handoffReply({ origin: EDITOR, source: tab, data: { type: HELLO } }, { ...expected, token: null })).toBeNull();
  });
});

describe("drive helpers", () => {
  it("formats sizes", () => {
    expect([0, 1023, 1536, 10 * 1024 * 1024, 3.25 * 1024 ** 3].map(formatBytes)).toEqual(["0 B", "1023 B", "1.5 KB", "10 MB", "3.3 GB"]);
    expect(formatBytes(null)).toBe("—");
  });

  it("computes how full the drive is", () => {
    expect(usagePercent(512, 1024)).toBe(50);
    expect(usagePercent(5000, 1024)).toBe(100);
    expect(usagePercent(1, null)).toBeNull();
  });

  it("takes PDFs only, by type or name", () => {
    const { accepted, rejected } = pdfFiles([
      { name: "a.pdf", type: "application/pdf" },
      { name: "B.PDF", type: "" },
      { name: "notes.txt", type: "text/plain" },
    ]);
    expect(accepted.map((f) => f.name)).toEqual(["a.pdf", "B.PDF"]);
    expect(rejected.map((f) => f.name)).toEqual(["notes.txt"]);
  });

  it("sends big files in parts", () => {
    expect(uploadMode(SINGLE_REQUEST_MAX)).toBe("single");
    expect(uploadMode(SINGLE_REQUEST_MAX + 1)).toBe("multipart");
  });

  it("says when the trash empties", () => {
    const now = new Date("2026-11-01T00:00:00Z");
    expect(purgeIn("2026-11-30T00:00:00Z", now)).toBe("in 29 days");
    expect(purgeIn("2026-11-01T12:00:00Z", now)).toBe("in 1 day");
    expect(purgeIn("2026-10-30T00:00:00Z", now)).toBe("today");
  });
});
