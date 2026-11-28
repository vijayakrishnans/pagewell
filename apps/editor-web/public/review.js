// Review in the editor (PW5): the comments panel, who is here, and the edit lease, for a document
// opened from the drive.
//
// - Comments live on the server (review-worker), not inside the PDF: the panel lists the
//   document's threads (carried to the current version by the server), starts one on a page,
//   replies, resolves and reopens. Everything is rendered as text, never as HTML.
// - The room: a WebSocket to the document's DocRoom, opened with a single-use ticket (the session
//   token never goes in a URL). It brings presence, the lease and new comments live; it reconnects
//   with a fresh ticket when it drops.
// - The lease: the first person here who may edit takes it and keeps renewing it; everyone else
//   is read-only (Save is off) until it is free, and someone who may share can break it. Saving
//   tells the room, and the others are offered a reload. The lease is a courtesy, not the guard:
//   when the room cannot be reached, saving stays on, and the drive's version check (409, save
//   as a copy) still stops one save overwriting another.

const RENEW_MS = 20_000;
const $ = (id) => document.getElementById(id);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(typeof c === "string" ? document.createTextNode(c) : c);
  return node;
}

const when = (iso) => {
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return "";
  }
};

/**
 * Start review for an open drive document. `cloud` is openFromDrive's handle; `setEditable`
 * turns saving on or off; `reload` opens the newest version.
 */
export function startReview({ cloud, say, setEditable, reload }) {
  const docId = cloud.document.id;
  const threads = new Map();
  const state = { blocked: false, me: null, ws: null, mine: false, holder: null, canEdit: false, canBreak: false, retry: 0, renew: null, closed: false };
  const side = $("side");
  const toggle = $("comments-toggle");
  side.hidden = false;
  toggle.hidden = false;
  toggle.addEventListener("click", () => {
    side.hidden = !side.hidden;
    toggle.setAttribute("aria-expanded", String(!side.hidden));
  });

  // ---- threads ----
  function render() {
    const list = $("threads");
    const sorted = [...threads.values()].sort((a, b) => a.anchor.page - b.anchor.page || a.createdAt.localeCompare(b.createdAt));
    list.replaceChildren(
      ...(sorted.length ? sorted.map(threadItem) : [el("li", { class: "muted" }, "No comments yet.")]),
    );
  }

  function threadItem(t) {
    const label = t.status === "outdated" ? "outdated: its text changed" : t.status;
    const comments = t.comments.map((c) =>
      el("div", { class: "comment" }, el("span", { class: "who" }, `${c.author.name ?? "Someone"} · ${when(c.createdAt)}${c.editedAt ? " · edited" : ""}`), c.deleted ? el("em", {}, "Deleted") : c.body),
    );
    const reply = el("textarea", { rows: "2", maxlength: "10000", "aria-label": "Reply", placeholder: "Reply" });
    const row = el(
      "div",
      { class: "row" },
      el("button", { class: "button", type: "button", onclick: () => send(`/threads/${t.id}/comments`, "POST", { body: reply.value }).then(() => (reply.value = "")) }, "Reply"),
      t.status === "outdated"
        ? null
        : el("button", { class: "button", type: "button", onclick: () => send(`/threads/${t.id}`, "PATCH", { status: t.status === "open" ? "resolved" : "open" }) }, t.status === "open" ? "Resolve" : "Reopen"),
    );
    return el(
      "li",
      { class: `thread ${t.status}`, "data-thread": t.id },
      el("header", {}, el("span", {}, `Page ${t.anchor.page}${t.anchor.quote ? ` · “${t.anchor.quote}”` : ""}`), el("span", {}, label)),
      ...comments,
      reply,
      row,
    );
  }

  async function send(path, method, body) {
    try {
      const res = await cloud.api(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const { data } = await res.json();
      if (data.thread) upsert(data.thread);
      else if (data.comment) await refresh();
      return data;
    } catch (err) {
      say(err?.status === 404 ? "You can't comment on this document." : `Comment not saved: ${err.message}`, true);
      return null;
    }
  }

  function upsert(t) {
    threads.set(t.id, t);
    render();
  }

  async function refresh() {
    try {
      const { data } = await (await cloud.api(`/documents/${docId}/threads`)).json();
      threads.clear();
      for (const t of data.threads) threads.set(t.id, t);
      render();
    } catch {
      /* the panel keeps what it has */
    }
  }

  $("comment-page").max = String(cloud.document.pageCount ?? 9999);
  $("comment-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const page = Number($("comment-page").value);
    const body = $("comment-body").value;
    const quote = $("comment-quote").value.trim() || null;
    // A comment on a page as a whole (the editor does not report a selection yet).
    const done = await send(`/documents/${docId}/threads`, "POST", { anchor: { page, rect: [0, 0, 0, 0], quote }, body });
    if (done) {
      $("comment-body").value = "";
      $("comment-quote").value = "";
    }
  });

  // ---- the room ----
  function presence(people) {
    const others = people.filter((p) => !(state.me && p.id === state.me));
    $("presence").textContent = others.length ? `Also here: ${others.map((p) => `${p.name ?? "someone"}${p.editing ? " (editing)" : ""}`).join(", ")}` : "Only you are here.";
  }

  function lease(ev) {
    state.mine = ev.mine;
    state.holder = ev.holder;
    state.blocked = !state.canEdit || Boolean(ev.holder && !ev.mine);
    const box = $("lease");
    clearInterval(state.renew);
    if (ev.mine) {
      state.renew = setInterval(() => cmd({ type: "lease.renew" }), RENEW_MS);
      box.hidden = true;
      setEditable(true);
      return;
    }
    setEditable(!state.blocked);
    if (ev.holder) {
      box.replaceChildren(`${ev.holder.name ?? "Someone"} is editing. You can read and comment; saving is off until they finish.`);
      if (state.canBreak) box.append(" ", el("button", { class: "button", type: "button", onclick: () => cmd({ type: "lease.break" }) }, "Take over"));
      box.hidden = false;
    } else if (state.canEdit) {
      // Free: take it.
      box.hidden = true;
      cmd({ type: "lease.take" });
    } else {
      box.replaceChildren("You can read and comment on this document.");
      box.hidden = false;
    }
  }

  function cmd(c) {
    if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(c));
  }

  async function connect() {
    if (state.closed) return;
    let t;
    try {
      t = (await (await cloud.api(`/documents/${docId}/room/ticket`, { method: "POST" })).json()).data;
    } catch (err) {
      // 404: no access to the room (or no review here); nothing to retry.
      return err?.status === 404 ? undefined : later();
    }
    state.canEdit = t.canEdit;
    state.canBreak = t.canBreak;
    const ws = new WebSocket(`${cloud.wsBase}/documents/${docId}/room?ticket=${encodeURIComponent(t.ticket)}`);
    state.ws = ws;
    ws.addEventListener("open", () => {
      state.retry = 0;
      refresh(); // anything said while we were away
    });
    ws.addEventListener("message", (e) => {
      let ev;
      try {
        ev = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (ev.type === "hello") state.me = ev.you.id;
      else if (ev.type === "presence") presence(ev.people);
      else if (ev.type === "lease") lease(ev);
      else if (ev.type === "thread") upsert(ev.thread);
      else if (ev.type === "version") {
        $("newer-text").textContent = `${ev.by ?? "Someone"} saved version ${ev.version}.`;
        $("newer").hidden = false;
      }
    });
    ws.addEventListener("close", () => {
      clearInterval(state.renew);
      if (state.ws === ws) {
        state.ws = null;
        // Nobody is known to hold the lease while we are away: saving falls back to the version check.
        state.blocked = !state.canEdit;
        setEditable(!state.blocked);
        later();
      }
    });
  }

  function later() {
    if (state.closed) return;
    const wait = Math.min(30_000, 1000 * 2 ** state.retry++);
    setTimeout(connect, wait);
  }

  $("newer-reload").addEventListener("click", () => reload());
  window.addEventListener("pagehide", () => {
    state.closed = true;
    if (state.mine) cmd({ type: "lease.release" });
    state.ws?.close();
  });

  render();
  refresh();
  connect();

  const handle = {
    /** After a save: tell the room so the others can reload. */
    saved(version) {
      cmd({ type: "version", version });
    },
    get canSave() {
      return !state.blocked;
    },
    get threads() {
      return [...threads.values()];
    },
  };
  return handle;
}
