// The signer's page (PW6), at /s/<token>: no account, the link token is the key (checked by
// sign-worker behind the API). The signer confirms their email address with a code, reads the
// documents exactly as sent (in the editor, view only), fills their own fields (a typed or drawn
// signature, initials, text, a checkbox; the date is set by the server), agrees to sign
// electronically, and signs, or declines. Everything shown is rendered as text.

const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.content ?? "";
const API = meta("pagewell-api");
const $ = (id) => document.getElementById(id);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== false && v !== null && v !== undefined) node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children) if (c != null) node.append(typeof c === "string" ? document.createTextNode(c) : c);
  return node;
}

const KIND = { signature: "Signature", initials: "Initials", date: "Date signed", text: "Text", checkbox: "Checkbox" };
const initialsOf = (name) => name.split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase()).join("").slice(0, 4);

/** A drawing pad: returns { el, clear, png() → base64 or null when empty }. */
function drawPad() {
  const canvas = el("canvas", { class: "sign-pad", "aria-label": "Draw your signature" });
  let ctx = null;
  let drawn = false;
  let last = null;
  const setup = () => {
    const r = canvas.getBoundingClientRect();
    const scale = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.max(1, Math.round(r.width * scale));
    canvas.height = Math.max(1, Math.round(r.height * scale));
    ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#1a1f4d";
  };
  const at = (e) => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  canvas.addEventListener("pointerdown", (e) => {
    if (!ctx) setup();
    canvas.setPointerCapture(e.pointerId);
    last = at(e);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!last) return;
    const p = at(e);
    ctx.beginPath();
    ctx.moveTo(...last);
    ctx.lineTo(...p);
    ctx.stroke();
    last = p;
    drawn = true;
  });
  const end = () => (last = null);
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  return {
    el: canvas,
    clear() {
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      drawn = false;
    },
    png() {
      if (!drawn) return null;
      return canvas.toDataURL("image/png").split(",")[1];
    },
  };
}

export async function startSigning({ token, say, openBytes }) {
  if (!API) {
    say("This page isn't connected to Pagewell.", true);
    return null;
  }
  const base = `${API}/v1/s/${encodeURIComponent(token)}`;
  const call = (path, init = {}) => fetch(base + path, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) } });
  const panel = $("sign");
  const body = $("sign-body");
  const show = (...nodes) => body.replaceChildren(...nodes);

  say("Opening…");
  const res = await call("");
  if (!res.ok) {
    say(res.status === 404 ? "This signing link doesn't work any more: it was used, replaced by a newer email, or the request was withdrawn or expired." : `Couldn't open it (${res.status}).`, true);
    return null;
  }
  const s = (await res.json()).data.session;
  panel.hidden = false;
  $("sign-title").textContent = s.envelope.title;
  $("sign-from").textContent = s.envelope.from ? `From ${s.envelope.from} to ${s.signer.name} <${s.signer.email}>` : `To ${s.signer.name} <${s.signer.email}>`;
  if (s.envelope.message) {
    $("sign-message").textContent = s.envelope.message;
    $("sign-message").hidden = false;
  }
  window.pagewell.signing = { session: s };

  if (!s.yourTurn) {
    say("Waiting for others to sign first");
    show(el("p", {}, "Others sign before you. We'll email you a new link when it's your turn."));
    return s;
  }

  // ---- step 1: the email code ----
  async function verifyStep() {
    const status = el("p", { class: "muted", role: "status" });
    const input = el("input", { type: "text", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "6", pattern: "[0-9]{6}", "aria-label": "Six-digit code", placeholder: "Six-digit code", hidden: true });
    const verifyBtn = el("button", { class: "button primary", type: "button", hidden: true }, "Verify");
    const sendBtn = el(
      "button",
      {
        class: "button primary",
        type: "button",
        onclick: async () => {
          sendBtn.disabled = true;
          const r = await call("/code", { method: "POST" });
          const data = r.ok ? (await r.json()).data : null;
          if (!r.ok) status.textContent = r.status === 429 ? "A code was sent a moment ago. Check your inbox, or try again in 30 seconds." : "Couldn't send a code.";
          else {
            status.textContent = `We emailed a code to ${s.signer.email}.`;
            input.hidden = false;
            verifyBtn.hidden = false;
            input.focus();
            // Stage only: the code comes back for tests (never in production).
            if (data?.delivery?.code) window.pagewell.signing.debugCode = data.delivery.code;
          }
          sendBtn.textContent = "Send another code";
          setTimeout(() => (sendBtn.disabled = false), 30_000);
        },
      },
      "Email me a code",
    );
    verifyBtn.addEventListener("click", async () => {
      const r = await call("/verify", { method: "POST", body: JSON.stringify({ code: input.value.trim() }) });
      if (r.ok) return documentsStep();
      const err = await r.json().catch(() => null);
      const left = err?.error?.details?.attemptsLeft;
      status.textContent = left ? `That code is wrong or has expired. ${left} tries left.` : "That code no longer works. Ask for another one.";
      input.value = "";
    });
    input.addEventListener("keydown", (e) => e.key === "Enter" && verifyBtn.click());
    say("Confirm your email address to continue");
    show(el("div", { class: "sign-step" }, el("p", {}, `To see the documents and sign, confirm that ${s.signer.email} is yours.`), sendBtn, input, verifyBtn, status));
  }

  // ---- step 2: read the documents, fill the fields ----
  async function documentsStep() {
    const opened = new Map();
    const openDoc = async (d) => {
      say(`Opening ${d.name}…`);
      let bytes = opened.get(d.documentId);
      if (!bytes) {
        const r = await call(`/documents/${d.documentId}`);
        if (!r.ok) {
          say(`Couldn't open ${d.name} (${r.status}).`, true);
          return;
        }
        bytes = new Uint8Array(await r.arrayBuffer());
        opened.set(d.documentId, bytes);
      }
      openBytes(bytes, d.name);
      say(`${d.name} — read it, then fill your fields`);
    };
    await openDoc(s.documents[0]);

    const docName = (id) => s.documents.find((d) => d.documentId === id)?.name ?? "";
    const inputs = [];
    const fieldNodes = s.fields.map((f) => {
      const head = el("header", {}, el("span", {}, `${KIND[f.kind]}${f.label ? ` — ${f.label}` : ""}`), el("span", {}, `${s.documents.length > 1 ? `${docName(f.documentId)}, ` : ""}page ${f.page}${f.required ? "" : " (optional)"}`));
      if (f.kind === "date") return el("div", { class: "sign-field" }, head, el("span", { class: "muted" }, "Filled with today's date when you sign."));
      if (f.kind === "checkbox") {
        const box = el("input", { type: "checkbox", id: `f-${f.id}` });
        inputs.push(() => ({ fieldId: f.id, checked: box.checked }));
        return el("div", { class: "sign-field" }, head, el("label", { class: "sign-consent", for: `f-${f.id}` }, box, el("span", {}, f.label ?? "Check")));
      }
      if (f.kind === "text") {
        const t = el("input", { type: "text", maxlength: "500", "aria-label": f.label ?? "Text" });
        inputs.push(() => (t.value.trim() ? { fieldId: f.id, text: t.value.trim() } : f.required ? { missing: f } : null));
        return el("div", { class: "sign-field" }, head, t);
      }
      // signature or initials: typed (shown in a script face) or drawn.
      const typed = el("input", { type: "text", maxlength: "100", value: f.kind === "initials" ? initialsOf(s.signer.name) : s.signer.name, "aria-label": `Type your ${KIND[f.kind].toLowerCase()}` });
      const preview = el("div", { class: "sign-typed", "aria-hidden": "true" }, typed.value);
      typed.addEventListener("input", () => (preview.textContent = typed.value));
      const pad = drawPad();
      const padWrap = el("div", { hidden: true }, pad.el, el("button", { class: "button", type: "button", onclick: () => pad.clear() }, "Clear"));
      const typeWrap = el("div", {}, typed, preview);
      let mode = "type";
      const tabType = el("button", { class: "button", type: "button", "aria-pressed": "true" }, "Type");
      const tabDraw = el("button", { class: "button", type: "button", "aria-pressed": "false" }, "Draw");
      const pick = (m) => {
        mode = m;
        tabType.setAttribute("aria-pressed", String(m === "type"));
        tabDraw.setAttribute("aria-pressed", String(m === "draw"));
        typeWrap.hidden = m !== "type";
        padWrap.hidden = m !== "draw";
      };
      tabType.addEventListener("click", () => pick("type"));
      tabDraw.addEventListener("click", () => pick("draw"));
      inputs.push(() => {
        if (mode === "draw") {
          const png = pad.png();
          return png ? { fieldId: f.id, imagePng: png } : f.required ? { missing: f } : null;
        }
        return typed.value.trim() ? { fieldId: f.id, text: typed.value.trim() } : f.required ? { missing: f } : null;
      });
      return el("div", { class: "sign-field", "data-field": f.id }, head, el("div", { class: "sign-tabs" }, tabType, tabDraw), typeWrap, padWrap);
    });

    const consent = el("input", { type: "checkbox", id: "sign-consent" });
    const status = el("p", { class: "muted", role: "status" });
    const signBtn = el("button", { class: "button primary", type: "button" }, "Sign");
    const declineBtn = el("button", { class: "button", type: "button" }, "Decline");
    signBtn.addEventListener("click", async () => {
      if (!consent.checked) {
        status.textContent = "Tick the box to agree to sign electronically.";
        return;
      }
      const values = [];
      for (const get of inputs) {
        const v = get();
        if (!v) continue;
        if (v.missing) {
          status.textContent = `Fill in: ${KIND[v.missing.kind]} on page ${v.missing.page}.`;
          return;
        }
        values.push(v);
      }
      signBtn.disabled = true;
      const r = await call("/submit", { method: "POST", body: JSON.stringify({ consent: true, values }) });
      signBtn.disabled = false;
      if (!r.ok) {
        const err = await r.json().catch(() => null);
        status.textContent = r.status === 404 ? "This link no longer works." : err?.error?.message ?? `Couldn't sign (${r.status}).`;
        return;
      }
      const done = (await r.json()).data;
      window.pagewell.signing.done = done;
      say("Signed");
      show(
        el(
          "div",
          { class: "sign-step" },
          el("p", { class: "sign-done" }, "You've signed. Thank you."),
          el("p", {}, done.envelopeStatus === "sent" ? "We'll email you the signed PDF when everyone has signed." : "Everyone has signed. We'll email you the signed PDF shortly."),
        ),
      );
    });
    declineBtn.addEventListener("click", () => {
      const reason = el("textarea", { rows: "3", maxlength: "1000", "aria-label": "Why you are declining (optional)", placeholder: "Why you are declining (optional)" });
      const confirm = el(
        "button",
        {
          class: "button",
          type: "button",
          onclick: async () => {
            const r = await call("/decline", { method: "POST", body: JSON.stringify({ reason: reason.value.trim() || null }) });
            if (!r.ok) {
              status.textContent = `Couldn't decline (${r.status}).`;
              return;
            }
            say("Declined");
            show(el("p", { class: "sign-done" }, "You declined. The sender has been told."));
          },
        },
        "Decline to sign",
      );
      show(el("div", { class: "sign-step" }, el("p", {}, "Declining closes this request for everyone."), reason, confirm, el("button", { class: "button", type: "button", onclick: () => documentsStep() }, "Back")));
    });

    show(
      el(
        "div",
        { class: "sign-step" },
        s.documents.length > 1 ? el("div", { class: "sign-docs" }, ...s.documents.map((d) => el("button", { class: "button", type: "button", onclick: () => openDoc(d) }, d.name))) : null,
        el("p", { class: "muted" }, s.fields.length === 1 ? "Your field:" : `Your ${s.fields.length} fields:`),
        ...fieldNodes,
        el("label", { class: "sign-consent", for: "sign-consent" }, consent, el("span", {}, "I agree to sign these documents electronically, and to the use of my email address and this signature to record it.")),
        el("div", { class: "row", style: "display:flex;gap:8px" }, signBtn, declineBtn),
        status,
      ),
    );
  }

  if (s.signer.verified) await documentsStep();
  else await verifyStep();
  return s;
}
