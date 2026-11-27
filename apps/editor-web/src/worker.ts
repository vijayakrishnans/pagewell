// Pagewell's editor on the web: a small worker in front of the static assets.
//
// - /edit/local and /edit/<docId> answer with the editor page (the page reads the path).
// - The editor's wasm is stored brotli-compressed (pkg/<hash>/*.wasm.br): Workers Static Assets
//   takes files up to 25 MiB, and the raw module is larger. The worker serves it as
//   application/wasm with Content-Encoding: br, passing the bytes through untouched.
// - Everything else is an asset.

export interface Env {
  ASSETS: Fetcher;
}

// The bundle lives under /pkg/<sourceHash>/, so its files can be cached as immutable.
const WASM = /^\/pkg\/[0-9a-f]{16,64}\/pagewell_web_bridge_bg\.wasm$/;
const DOC_ID = /^\/edit\/([A-Za-z0-9_-]{1,64})\/?$/;

// The editor runs as wasm and draws on a canvas; it loads nothing from other origins.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

function withHeaders(res: Response, extra: Record<string, string>, init?: ResponseInit & { encodeBody?: "manual" }): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers, ...init });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/" || path === "/edit" || path === "/edit/") {
      return Response.redirect(new URL("/edit/local", url).toString(), 302);
    }

    if (path === "/health") {
      return Response.json({ ok: true, service: "editor-web" });
    }

    if (DOC_ID.test(path)) {
      // `/editor`, not `/editor.html`: the assets' html handling redirects the latter.
      const page = await env.ASSETS.fetch(new URL("/editor", url));
      return withHeaders(page, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": CSP, "Cache-Control": "no-cache" });
    }

    if (WASM.test(path)) {
      const br = await env.ASSETS.fetch(new URL(`${path}.br`, url));
      if (!br.ok) return br;
      return withHeaders(
        br,
        { "Content-Type": "application/wasm", "Content-Encoding": "br", "Cache-Control": "public, max-age=31536000, immutable" },
        { encodeBody: "manual" },
      );
    }

    if (path.startsWith("/pkg/") && path.endsWith(".br")) {
      return new Response("not found", { status: 404 });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
