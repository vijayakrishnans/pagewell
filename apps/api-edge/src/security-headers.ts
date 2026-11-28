// Security headers on every API response (OWASP A05, PW-26). The API serves JSON and, for the
// drive, bytes (PDFs, thumbnails, job files): nothing here is a page, so every response says so.
// `sandbox` and `default-src 'none'` keep a PDF or image opened straight from the API from running
// anything; nosniff keeps a browser from guessing a type; frame-ancestors stops framing.

const HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'; sandbox",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
};

export function applySecurityHeaders(response: Response): Response {
  // 101 (WebSocket upgrades) and responses without a body keep their own headers untouched.
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(HEADERS)) if (!headers.has(k)) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
