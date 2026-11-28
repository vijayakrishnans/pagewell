// The console's security headers (PW-26, OWASP A05): every route, a CSP with no plugins or
// framing, and an opener policy that still lets the editor tab ask the console for its session.
import { CONSOLE_CSP, SECURITY_HEADERS } from "../../../apps/web-console-next/security-headers.mjs";

const header = (k: string) => SECURITY_HEADERS.find((h: { key: string }) => h.key === k)?.value;

describe("console security headers", () => {
  it("frames nothing, loads no plugins, and keeps scripts to this origin", () => {
    for (const d of ["default-src 'self'", "script-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "frame-src 'none'", "base-uri 'self'", "form-action 'self'"]) expect(CONSOLE_CSP).toContain(d);
    expect(CONSOLE_CSP).not.toContain("unsafe-eval");
    expect(header("X-Frame-Options")).toBe("DENY");
    expect(header("X-Content-Type-Options")).toBe("nosniff");
    expect(header("Strict-Transport-Security")).toMatch(/max-age=31536000/);
    expect(header("Permissions-Policy")).toContain("camera=()");
  });

  it("allows the editor popup to talk back (same-origin-allow-popups, not same-origin)", () => {
    expect(header("Cross-Origin-Opener-Policy")).toBe("same-origin-allow-popups");
  });
});
