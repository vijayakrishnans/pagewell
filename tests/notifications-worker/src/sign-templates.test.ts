import { renderEmailTemplate } from "../../../apps/notifications-worker/src/templates/index.js";

// E-sign emails (PW6): the link and the code appear, escaped; only plain https links become links;
// the completed email carries the signed file's hash; nothing says "advanced" or "qualified".
describe("sign templates", () => {
  it("a request names the sender, links the signing page and says the link's end", () => {
    const r = renderEmailTemplate("sign.requested", { title: "Generated <agreement>", from: "ann@example.com", message: "Please sign", signUrl: "https://editor.example.com/s/abc", expiresAt: "2026-12-12T00:00:00Z" }, { brandName: "Pagewell" })!;
    expect(r.subject).toBe('Please sign "Generated <agreement>" on Pagewell');
    expect(r.html).toContain("Generated &lt;agreement&gt;");
    expect(r.html).toContain('href="https://editor.example.com/s/abc"');
    expect(r.text).toContain("simple electronic signature");
    const bad = renderEmailTemplate("sign.requested", { title: "x", signUrl: "javascript:alert(1)" }, {})!;
    expect(bad.html).not.toContain("javascript:");
    expect(renderEmailTemplate("sign.reminder", { title: "x", signUrl: "https://e.example.com/s/new" }, {})!.text).toContain("Earlier links no longer work");
  });

  it("a code shows six digits and nothing else", () => {
    expect(renderEmailTemplate("sign.code", { code: "042917", title: "x" }, {})!.text).toContain("is 042917.");
    expect(renderEmailTemplate("sign.code", { code: "<b>1</b>", title: "x" }, {})!.html).not.toContain("<b>1</b>");
  });

  it("declined, voided and completed say what happened; completed has the hash and the download", () => {
    expect(renderEmailTemplate("sign.declined", { title: "x", signerName: "Ben", signerEmail: "ben@example.com", reason: "Wrong amount" }, {})!.text).toContain("Ben <ben@example.com> declined");
    expect(renderEmailTemplate("sign.voided", { title: "x", reason: null }, {})!.text).toContain("withdrawn");
    const done = renderEmailTemplate("sign.completed", { title: "x", sha256: "a".repeat(64), downloadUrl: "https://e.example.com/l/tok" }, {})!;
    expect(done.text).toContain(`SHA-256 is ${"a".repeat(64)}`);
    expect(done.html).toContain('href="https://e.example.com/l/tok"');
    for (const k of ["sign.requested", "sign.completed"]) expect(renderEmailTemplate(k, { title: "x" }, {})!.text).not.toMatch(/advanced|qualified/i);
  });
});
