import { renderEmailTemplate } from "@notifications-worker/templates/index";

// Pagewell's review emails (PW5): mention, request, reminder. Names and text escaped; only plain
// https links become buttons.
describe("review templates", () => {
  it("a mention names who, where and quotes the comment, escaped", () => {
    const r = renderEmailTemplate("review.mentioned", { documentName: "Plan.pdf", page: 3, excerpt: "<b>look</b> here", by: "ana@example.com", openUrl: "https://editor.example.com/edit/doc_1?org=org_1" }, { brandName: "Pagewell" })!;
    expect(r.subject).toBe('You were mentioned in "Plan.pdf" on Pagewell');
    expect(r.text).toContain("ana@example.com mentioned you in a comment on page 3 of \"Plan.pdf\".");
    expect(r.html).not.toContain("<b>look</b>");
    expect(r.html).toContain('href="https://editor.example.com/edit/doc_1?org=org_1"');
  });
  it("a request carries the message and due date; a reminder says overdue", () => {
    const req = renderEmailTemplate("review.requested", { documentName: "Plan.pdf", by: "ana@example.com", message: "By Friday please", dueAt: "2026-12-04T17:00:00.000Z", openUrl: "javascript:alert(1)" }, {})!;
    expect(req.text).toContain("Message: By Friday please");
    expect(req.html).not.toContain("javascript:");
    const rem = renderEmailTemplate("review.reminder", { dueAt: "2026-12-04T17:00:00.000Z", overdue: true, openUrl: null }, {})!;
    expect(rem.subject).toContain("Overdue");
  });
});
