// The console's security headers (OWASP A05, PW-26), applied to every route by next.config.mjs.
//
// - CSP: scripts and styles from this origin only ('unsafe-inline' because Next's runtime inlines
//   its bootstrap; there is no eval), no plugins, no framing, no <base> or form posts elsewhere.
//   connect-src is any https origin: the console talks to the API of the environment it targets,
//   whose origin is chosen at runtime (lib/app-config.ts).
// - COOP same-origin-allow-popups: the console opens the editor in a new tab and answers its
//   hello over window.opener (lib/drive.ts); plain same-origin would cut that link.
// - No camera, microphone or location; HSTS; nosniff; a strict referrer.

export const CONSOLE_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https:",
  "frame-src 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

export const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CONSOLE_CSP },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
];
