// Pagewell's drive, from the editor (PW2).
//
// /edit/<doc_…>?org=<org_…> opens a document in the drive and saves each change as its next
// version. The editor is its own origin and holds no login of its own: the console opens this
// tab and, when the tab says hello, posts it the session (console: lib/drive.ts). The session
// is accepted only from the console's origin and the window that opened this tab, for this org
// and this API, and kept in sessionStorage: this tab only, never in a URL.
//
// A save names the version it started from. If someone saved since, the API answers
// 409 version_conflict and the user chooses: save as a copy, reload (dropping their changes),
// or keep editing. Each save also sends a page-1 thumbnail and the document's text, for the
// drive's listing and for search later; those are best-effort and never block the save.

const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.content ?? "";
const API = meta("pagewell-api");
const CONSOLE = meta("pagewell-console");
const KEY = "pagewell.session";
const DOC_ID = /^doc_[0-9a-f]{32}$/;
const ORG_ID = /^org_[0-9a-f]{32}$/;
const HANDOFF_WAIT_MS = 15_000;
const TEXT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * The session in a message, if the message is the console's handoff for this tab: from the
 * console's origin, from the window that opened this tab, for this org and this API.
 */
export function acceptHandoff(event, expected) {
  if (!expected.consoleOrigin || event.origin !== expected.consoleOrigin) return null;
  if (!event.source || event.source !== expected.opener) return null;
  const d = event.data;
  if (!d || typeof d !== "object" || d.type !== "pagewell:session") return null;
  if (d.orgId !== expected.orgId || d.apiBase !== expected.apiOrigin) return null;
  if (typeof d.token !== "string" || d.token.length < 8 || d.token.length > 4096) return null;
  return { token: d.token, apiBase: d.apiBase, orgId: d.orgId };
}

function readSession(orgId) {
  try {
    const s = JSON.parse(sessionStorage.getItem(KEY) ?? "null");
    if (s && s.orgId === orgId && s.apiBase === API && typeof s.token === "string") return s;
  } catch {
    /* no session */
  }
  return null;
}

function forgetSession() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* nothing to forget */
  }
}

/** This tab's session: kept from earlier, or handed over by the console that opened it. */
function waitForSession(orgId) {
  const kept = readSession(orgId);
  if (kept) return Promise.resolve(kept);
  const opener = window.opener;
  if (!opener || !CONSOLE || !API) return Promise.resolve(null);
  return new Promise((resolve) => {
    const done = (session) => {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(session);
    };
    const onMessage = (event) => {
      const session = acceptHandoff(event, { consoleOrigin: CONSOLE, opener, orgId, apiOrigin: API });
      if (!session) return;
      try {
        sessionStorage.setItem(KEY, JSON.stringify(session));
      } catch {
        /* the tab still has it in memory */
      }
      done(session);
    };
    const timer = setTimeout(() => done(null), HANDOFF_WAIT_MS);
    window.addEventListener("message", onMessage);
    // The hello carries nothing; it is addressed to the console's origin only.
    opener.postMessage({ type: "pagewell:hello" }, CONSOLE);
  });
}

const params = new URLSearchParams(location.search);
const pathDoc = location.pathname.replace(/^\/edit\/?/, "").replace(/\/$/, "");
const orgParam = params.get("org") ?? "";
// Ask for the session while the editor's wasm is still loading.
const early = DOC_ID.test(pathDoc) && ORG_ID.test(orgParam) ? waitForSession(orgParam) : Promise.resolve(null);

class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message ?? `The drive answered ${status}`);
    this.status = status;
    this.code = body?.error?.code ?? "error";
    this.details = body?.error?.details ?? {};
  }
}

function client(session) {
  const base = `${API}/v1/organizations/${session.orgId}`;
  return async function api(path, init = {}) {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${session.token}`);
    const res = await fetch(base + path, { ...init, headers });
    if (!res.ok) {
      let body = null;
      try {
        body = await res.json();
      } catch {
        /* not JSON */
      }
      if (res.status === 401) forgetSession();
      throw new ApiError(res.status, body);
    }
    return res;
  };
}

function fromBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Ask the user what to do about a newer version: "copy", "reload" or "cancel". */
function askAboutConflict(current) {
  const dialog = document.getElementById("conflict");
  document.getElementById("conflict-version").textContent = String(current);
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue || "cancel"), { once: true });
    dialog.showModal();
  });
}

function copyName(name) {
  const stem = name.replace(/\.pdf$/i, "");
  return `${stem} (copy).pdf`.slice(0, 255);
}

/**
 * Open the drive document this page names. Resolves to the cloud handle `{ save }` the page
 * uses for saves, or null (after saying why) when it cannot.
 */
export async function openFromDrive({ docId, say, openBytes, automation, leave }) {
  if (!DOC_ID.test(docId) || !ORG_ID.test(orgParam)) {
    say("This link is missing its document or organization.", true);
    return null;
  }
  if (!API) {
    say("This editor isn't connected to a drive. Open the document from Pagewell.", true);
    return null;
  }
  say("Waiting for your Pagewell session…");
  const session = await early;
  if (!session) {
    say("Open this document from your drive in Pagewell: this tab has no session.", true);
    return null;
  }
  const api = client(session);
  let doc;
  let base;

  async function load() {
    say("Opening…");
    doc = (await (await api(`/documents/${docId}`)).json()).data.document;
    const res = await api(`/documents/${docId}/content`);
    base = Number(res.headers.get("x-pagewell-version")) || doc.currentVersion;
    openBytes(new Uint8Array(await res.arrayBuffer()), doc.name);
    say(`${doc.name} — version ${base}`);
  }

  async function pageCount() {
    try {
      const r = await automation({ tool: "doc_inspect" });
      return Number(r.result?.[0]?.document?.pages) || null;
    } catch {
      return null;
    }
  }

  // The listing's thumbnail and the text for search: best-effort, after the save is safe.
  async function afterSave(version) {
    try {
      const r = await automation({ tool: "page_render", args: { page: 1, dpi: 36 } });
      const png = r.result?.find?.((c) => c?.type === "image/png" && typeof c.data === "string");
      if (png) {
        await api(`/documents/${docId}/versions/${version}/thumbnail`, { method: "PUT", headers: { "content-type": "image/png" }, body: fromBase64(png.data) });
      }
    } catch {
      /* the listing shows a plain icon */
    }
    try {
      const r = await automation({ tool: "text_extract", args: {} });
      const pages = (r.result?.[0]?.pages ?? []).map((p, i) => ({ page: Number(p.page) || i + 1, text: String(p.text ?? "") }));
      const body = JSON.stringify({ pages });
      if (pages.length && body.length <= TEXT_MAX_BYTES) {
        await api(`/documents/${docId}/versions/${version}/text`, { method: "PUT", headers: { "content-type": "application/json" }, body });
      }
    } catch {
      /* search will not find this version's text */
    }
  }

  async function save(bytes) {
    say("Saving…");
    const pages = await pageCount();
    try {
      const res = await api(`/documents/${docId}/versions`, {
        method: "POST",
        headers: { "content-type": "application/pdf", "x-pagewell-base-version": String(base), ...(pages ? { "x-pagewell-page-count": String(pages) } : {}) },
        body: bytes,
      });
      const { version } = (await res.json()).data;
      base = version.version;
      say(`Saved version ${base}`);
      void afterSave(base);
      return version;
    } catch (err) {
      if (!(err instanceof ApiError) || err.code !== "version_conflict") {
        say(err instanceof ApiError && err.status === 401 ? "Your session ended. Open the document from your drive again." : `Not saved: ${err.message}`, true);
        throw err;
      }
      const choice = await askAboutConflict(err.details.currentVersion);
      if (choice === "copy") {
        const q = new URLSearchParams({ name: copyName(doc.name), ...(doc.folderId ? { folderId: doc.folderId } : {}) });
        const res = await api(`/documents?${q}`, { method: "POST", headers: { "content-type": "application/pdf" }, body: bytes });
        const copy = (await res.json()).data.document;
        say(`Saved as ${copy.name}`);
        leave(`/edit/${copy.id}?org=${session.orgId}`);
        return null;
      }
      if (choice === "reload") {
        await load();
        return null;
      }
      say(`Not saved: version ${err.details.currentVersion} is newer`, true);
      return null;
    }
  }

  /**
   * Print (PW4): a print-ready PDF of the version open here, made on the server by a print job,
   * opened in `tab` (opened by the click, so the browser lets it through).
   */
  async function print(tab) {
    say("Preparing the print-ready PDF…");
    const jobsBase = `${API}/v1/organizations/${session.orgId}/jobs`;
    const auth = { authorization: `Bearer ${session.token}` };
    const started = await fetch(jobsBase, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ operation: "print", documentIds: [docId], version: base }) });
    if (!started.ok) {
      tab?.close();
      let code = "";
      try {
        code = (await started.json()).error?.code ?? "";
      } catch {
        /* not JSON */
      }
      say(code === "runner_unavailable" ? "Printing from the server isn't available yet. Use your browser's print instead." : `Couldn't print (${started.status}).`, true);
      return;
    }
    let job = (await started.json()).data.job;
    for (let i = 0; i < 150 && (job.status === "queued" || job.status === "running"); i++) {
      await new Promise((r) => setTimeout(r, 2000));
      job = (await (await fetch(`${jobsBase}/${job.id}`, { headers: auth })).json()).data.job;
    }
    if (job.status !== "succeeded") {
      tab?.close();
      say(`Couldn't print: ${job.error?.message ?? "it took too long"}`, true);
      return;
    }
    const file = await fetch(`${jobsBase}/${job.id}/files/result.pdf`, { headers: auth });
    if (!file.ok) {
      tab?.close();
      say("Couldn't open the print-ready PDF.", true);
      return;
    }
    const url = URL.createObjectURL(new Blob([await file.arrayBuffer()], { type: "application/pdf" }));
    if (tab) tab.location.href = url;
    else window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    say(`${doc.name} — version ${base}`);
    return url;
  }

  try {
    await load();
  } catch (err) {
    say(err instanceof ApiError && err.status === 404 ? "This document isn't in your drive, or it was moved to the trash." : `Couldn't open: ${err.message}`, true);
    return null;
  }
  return {
    save,
    print,
    /** The drive API for this organization, signed in (review uses it). */
    api,
    /** The same API as a WebSocket origin and path, for the document's room. */
    wsBase: `${API.replace(/^http/, "ws")}/v1/organizations/${session.orgId}`,
    get version() {
      return base;
    },
    get document() {
      return doc;
    },
  };
}

// ---- Share links (PW3) ----
//
// /l/<token> opens what a share link points at, read-only, with no account: the token is the
// key and the drive API checks it on every request (a revoked link stops on the next one). A
// link with a password asks for it; the password is kept for this tab only, never in the URL.
// A folder link lists the folder so the viewer can pick a document.

const LINK_PASSWORD_HEADER = "x-pagewell-link-password";
const linkKey = (token) => `pagewell.link.${token.slice(0, 12)}`;

function askPassword(wrong) {
  const dialog = document.getElementById("link-password");
  const input = document.getElementById("link-password-input");
  document.getElementById("link-password-text").textContent = wrong
    ? "That password didn't work. Try again."
    : "Enter the password the person who shared it gave you.";
  input.value = "";
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok" && input.value ? input.value : null), { once: true });
    dialog.showModal();
    input.focus();
  });
}

/** Ask which document of a folder link to open (folders inside it can be browsed). */
function pickFromFolder(listing, browse) {
  const dialog = document.getElementById("link-folder");
  const list = document.getElementById("link-folder-list");
  document.getElementById("link-folder-title").textContent = listing.folder?.name ?? "Shared folder";
  document.getElementById("link-folder-path").textContent = listing.documents.length || listing.folders.length ? "Choose a document to open." : "This folder is empty.";
  list.replaceChildren();
  return new Promise((resolve) => {
    const done = (value) => {
      dialog.removeEventListener("close", onClose);
      if (dialog.open) dialog.close();
      resolve(value);
    };
    const onClose = () => resolve(null);
    const row = (label, onClick) => {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.addEventListener("click", onClick);
      li.append(b);
      list.append(li);
    };
    for (const f of listing.folders) row(`📁 ${f.name}`, () => done(browse(f.id)));
    for (const d of listing.documents) row(d.name, () => done({ document: d }));
    dialog.addEventListener("close", onClose, { once: true });
    if (!dialog.open) dialog.showModal();
  });
}

/**
 * Open the share link this page names. Resolves to `{ allowDownload, name }` once a document is
 * open, or null (after saying why).
 */
export async function openFromLink({ token, say, openBytes }) {
  if (!API) {
    say("This viewer isn't connected to a drive.", true);
    return null;
  }
  let password = null;
  try {
    password = sessionStorage.getItem(linkKey(token));
  } catch {
    /* no storage: ask */
  }
  const base = `${API}/v1/l/${encodeURIComponent(token)}`;
  const get = (path) => fetch(base + path, { headers: password ? { [LINK_PASSWORD_HEADER]: password } : {} });

  say("Opening the shared link…");
  let res = await get("");
  for (let attempt = 0; res.status === 401 && attempt < 5; attempt++) {
    password = await askPassword(attempt > 0 || password !== null);
    if (password === null) {
      say("This link needs its password.", true);
      return null;
    }
    res = await get("");
  }
  if (res.status === 404) {
    say("This link doesn't work any more. It may have been turned off or expired.", true);
    return null;
  }
  if (!res.ok) {
    say(res.status === 429 ? "Too many tries. Wait a minute and try again." : `Couldn't open the link (${res.status}).`, true);
    return null;
  }
  try {
    if (password) sessionStorage.setItem(linkKey(token), password);
  } catch {
    /* keep it in memory only */
  }

  let opened = (await res.json()).data;
  let doc = opened.document;
  if (!doc) {
    const browse = async (folderId) => {
      const r = await get(`?folderId=${encodeURIComponent(folderId)}`);
      return r.ok ? { listing: (await r.json()).data } : { listing: null };
    };
    let listing = opened;
    for (;;) {
      say("Choose a document from the shared folder.");
      const choice = await pickFromFolder(listing, browse);
      if (!choice) {
        say("Nothing opened. Reload the page to choose again.");
        return null;
      }
      const resolved = await choice;
      if (resolved.document) {
        doc = resolved.document;
        break;
      }
      if (!resolved.listing) {
        say("That folder isn't available.", true);
        return null;
      }
      listing = resolved.listing;
    }
  }

  const content = await get(`/content?documentId=${encodeURIComponent(doc.id)}`);
  if (!content.ok) {
    say(content.status === 404 ? "This document isn't shared any more." : `Couldn't open it (${content.status}).`, true);
    return null;
  }
  const bytes = new Uint8Array(await content.arrayBuffer());
  openBytes(bytes, doc.name);
  say(`${doc.name} — view only`);
  return { allowDownload: opened.link.allowDownload && content.headers.get("x-pagewell-allow-download") !== "0", name: doc.name, bytes };
}
