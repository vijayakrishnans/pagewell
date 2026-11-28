import { renderEmailTemplate } from "@notifications-worker/templates/index";

// Pagewell's share invitation (PW3): what a guest gets when a folder or document is shared
// with their address.
describe("files.shared template", () => {
  it("names what was shared and the role, with the message and a button to open Pagewell", () => {
    const r = renderEmailTemplate(
      "files.shared",
      { role: "commenter", resourceKind: "document", resourceName: "Generated.pdf", message: "Have a look", openUrl: "https://console.example.com/shared" },
      { brandName: "Pagewell" },
    )!;
    expect(r.subject).toBe('"Generated.pdf" was shared with you on Pagewell');
    expect(r.text).toContain('You can now comment on the document "Generated.pdf".');
    expect(r.text).toContain("Message: Have a look");
    expect(r.text).toContain("Open it: https://console.example.com/shared");
    expect(r.html).toContain('href="https://console.example.com/shared"');
  });

  it("escapes names and messages, and drops a link that is not plain https", () => {
    const r = renderEmailTemplate(
      "files.shared",
      { role: "editor", resourceKind: "folder", resourceName: "<script>x</script>", message: "<b>hi</b>", openUrl: "javascript:alert(1)" },
      {},
    )!;
    expect(r.html).not.toContain("<script>");
    expect(r.html).not.toContain("<b>hi</b>");
    expect(r.html).not.toContain("javascript:");
    expect(r.text).not.toContain("javascript:");
    expect(r.text).toContain("You can now edit the folder");
  });
});
