import { applySecurityHeaders } from "@api-edge/security-headers";

// Every API response carries security headers (PW-26, OWASP A05): nothing the API serves is a
// page, so a PDF or image opened straight from it runs nothing and cannot be framed.
describe("api-edge security headers", () => {
  it("adds them to JSON and to bytes, keeping what a response already set", async () => {
    const json = applySecurityHeaders(Response.json({ data: {} }));
    expect(json.headers.get("x-content-type-options")).toBe("nosniff");
    expect(json.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'; sandbox");
    expect(json.headers.get("x-frame-options")).toBe("DENY");
    expect(json.headers.get("strict-transport-security")).toContain("max-age=31536000");
    expect(json.headers.get("referrer-policy")).toBe("no-referrer");
    const pdf = applySecurityHeaders(new Response("%PDF-1.7", { headers: { "content-type": "application/pdf", "x-content-type-options": "nosniff", "x-pagewell-version": "3" } }));
    expect(pdf.headers.get("content-security-policy")).toContain("sandbox");
    expect(pdf.headers.get("x-pagewell-version")).toBe("3");
    expect(await pdf.text()).toBe("%PDF-1.7");
    const status = applySecurityHeaders(new Response(null, { status: 204 }));
    expect(status.status).toBe(204);
  });
});
