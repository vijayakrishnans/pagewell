// Pagewell's editor on the web: a small worker in front of the static assets.
//
// - /edit/local and /edit/<docId> answer with the editor page (the page reads the path).
// - The editor's wasm is stored brotli-compressed (pkg/<hash>/*.wasm.br): Workers Static Assets
//   takes files up to 25 MiB, and the raw module is larger. The worker serves it as
//   application/wasm with Content-Encoding: br, passing the bytes through untouched.
// - /edit/<doc_…>?org=<org_…> opens a document from the drive (PW2). The page talks to the
//   API (api-edge) and accepts its session only from the console, so the worker writes both
//   origins into the page and allows the API, and only the API, in connect-src.
// - Everything else is an asset.

export interface Env {
  ASSETS: Fetcher;
  /** Overrides for local runs (wrangler dev --var): deployed origins come from the host name. */
  API_ORIGIN?: string;
  CONSOLE_ORIGIN?: string;
}

// The fleet's workers.dev names: pagewell-<service>-<env>.<subdomain>.workers.dev.
const EDITOR_HOST = /^pagewell-editor-web-(stage|prod|dev)\.([a-z0-9-]+\.workers\.dev)$/;
const ORIGIN = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/;

/** The API and console this editor deploy pairs with, or nulls where there are none (local). */
export function peers(host: string, env: Pick<Env, "API_ORIGIN" | "CONSOLE_ORIGIN">): { api: string | null; console: string | null } {
  const m = host.toLowerCase().match(EDITOR_HOST);
  const api = env.API_ORIGIN && ORIGIN.test(env.API_ORIGIN) ? env.API_ORIGIN : m ? `https://pagewell-api-edge-${m[1]}.${m[2]}` : null;
  const console = env.CONSOLE_ORIGIN && ORIGIN.test(env.CONSOLE_ORIGIN) ? env.CONSOLE_ORIGIN : m ? `https://pagewell-web-console-next-${m[1]}.${m[2]}` : null;
  return { api, console };
}

// The bundle lives under /pkg/<sourceHash>/, so its files can be cached as immutable.
const WASM = /^\/pkg\/[0-9a-f]{16,64}\/pagewell_web_bridge_bg\.wasm$/;
const DOC_ID = /^\/edit\/([A-Za-z0-9_-]{1,64})\/?$/;
// A share link opened read-only (PW3): the token is the key, checked by the drive API.
const LINK = /^\/l\/([A-Za-z0-9_-]{20,128})\/?$/;

// The editor runs as wasm and draws on a canvas; it loads nothing from other origins, and
// talks only to its own origin and the drive API.
const csp = (api: string | null) => [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  api ? `connect-src 'self' ${api}` : "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const escapeAttr = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

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

    if (DOC_ID.test(path) || LINK.test(path)) {
      // `/editor`, not `/editor.html`: the assets' html handling redirects the latter.
      const page = await env.ASSETS.fetch(new URL("/editor", url));
      if (!page.ok) return page;
      const { api, console } = peers(url.host, env);
      const html = (await page.text()).replace("__API_ORIGIN__", escapeAttr(api ?? "")).replace("__CONSOLE_ORIGIN__", escapeAttr(console ?? ""));
      return withHeaders(new Response(html, page), {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": csp(api),
        "Cache-Control": "no-cache",
      });
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
