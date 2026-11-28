// pdf-runner's operations (PW4): each one is a fixed pdfcraft-cli script over files the runner
// names itself (in-0.pdf, in-1.pdf … and out/…). Nothing from a request becomes a path: options
// are validated into numbers, booleans and enums, and every path below is a literal. The CLI then
// runs with --root <jobdir>, which refuses any path outside the job's directory as well.

export const OPERATIONS = ["ocr", "compress", "merge", "split", "extract", "rotate", "flatten", "redact", "sanitize", "render", "text", "print", "sign_complete"];

export class OptionError extends Error {
  constructor(field, message) {
    super(`${field}: ${message}`);
    this.field = field;
  }
}

const isInt = (v) => Number.isInteger(v);

/** A list of 1-based page numbers, each within 1..pageCount, no more than `max` of them. */
function pages(value, pageCount, field = "pages", max = 10_000) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > max) throw new OptionError(field, "a non-empty list of page numbers");
  for (const p of value) if (!isInt(p) || p < 1 || p > pageCount) throw new OptionError(field, `page numbers from 1 to ${pageCount}`);
  return [...value];
}

function oneOf(value, allowed, field, fallback) {
  if (value === undefined || value === null) return fallback;
  if (!allowed.includes(value)) throw new OptionError(field, `one of ${allowed.join(", ")}`);
  return value;
}

function bool(value, field, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new OptionError(field, "true or false");
  return value;
}

function intIn(value, lo, hi, field, fallback) {
  if (value === undefined || value === null) return fallback;
  if (!isInt(value) || value < lo || value > hi) throw new OptionError(field, `a whole number from ${lo} to ${hi}`);
  return value;
}

const open = (i) => ({ tool: "doc_open", args: { path: `in-${i}.pdf` } });
const save = { tool: "doc_save", args: { doc: 1, path: "out/result.pdf", full: true } };
const RESULT = [{ name: "result.pdf", type: "application/pdf" }];

/**
 * The script for an operation, and what it leaves in out/. `inputs` is how many files came in;
 * `pageCounts` their page counts (from a first pass that opened them).
 * Returns { steps, outputs } where outputs is a list of { name, type } or { dir, type } (every
 * file the step wrote in out/), or { fromReport } for results the CLI returns as JSON.
 */
export function plan(operation, options = {}, inputs = 1, pageCounts = [1], extra = {}) {
  if (!OPERATIONS.includes(operation)) throw new OptionError("operation", `one of ${OPERATIONS.join(", ")}`);
  if (options === null || typeof options !== "object" || Array.isArray(options)) throw new OptionError("options", "an object");
  const n = pageCounts[0] ?? 1;
  if (operation === "sign_complete") return signComplete(options, inputs, pageCounts, extra);
  if (operation !== "merge" && inputs !== 1) throw new OptionError("inputs", `${operation} takes exactly one PDF`);
  if (operation === "merge" && (inputs < 2 || inputs > 50)) throw new OptionError("inputs", "merge takes 2 to 50 PDFs");

  switch (operation) {
    case "ocr": {
      const args = { doc: 1, output_mode: "searchable", language: oneOf(options.language, ["en"], "language", "en"), force_ocr: bool(options.force, "force", false), skip_text_pages: !bool(options.force, "force", false) };
      const p = pages(options.pages, n);
      if (p) args.pages = p;
      return { steps: [open(0), { tool: "ocr_recognize", args }, save], outputs: RESULT };
    }
    case "compress":
      return { steps: [open(0), { tool: "doc_optimize", args: { doc: 1, path: "out/result.pdf", preset: oneOf(options.preset, ["standard", "mobile"], "preset", "standard") } }], outputs: RESULT };
    case "merge":
      return { steps: [{ tool: "doc_combine", args: { paths: Array.from({ length: inputs }, (_, i) => `in-${i}.pdf`), out: "out/result.pdf" } }], outputs: RESULT };
    case "split": {
      const every = intIn(options.every, 1, n, "every", undefined);
      const before = pages(options.before, n, "before");
      if (!every === !before) throw new OptionError("options", "exactly one of every or before");
      return { steps: [open(0), { tool: "doc_split", args: { doc: 1, out_dir: "out", ...(every ? { every } : { before }) } }], outputs: [{ dir: "out", type: "application/pdf" }] };
    }
    case "extract": {
      const p = pages(options.pages, n);
      if (!p) throw new OptionError("pages", "the pages to extract");
      return { steps: [open(0), { tool: "page_extract", args: { doc: 1, pages: p, out: "out/result.pdf" } }], outputs: RESULT };
    }
    case "rotate": {
      const degrees = oneOf(options.degrees, [90, 180, 270, -90], "degrees", undefined);
      if (degrees === undefined) throw new OptionError("degrees", "90, 180, 270 or -90");
      const args = { doc: 1, degrees };
      const p = pages(options.pages, n);
      if (p) args.pages = p;
      return { steps: [open(0), { tool: "page_rotate", args }, save], outputs: RESULT };
    }
    case "flatten":
      return {
        steps: [open(0), { tool: "doc_flatten", args: { doc: 1, comments: bool(options.comments, "comments", true), fields: bool(options.fields, "fields", true) } }, save],
        outputs: RESULT,
      };
    case "redact": {
      const args = { doc: 1 };
      const p = pages(options.pages, n);
      if (p) args.pages = p;
      return { steps: [open(0), { tool: "redact_apply", args }, save], outputs: RESULT };
    }
    case "sanitize":
      return { steps: [open(0), { tool: "doc_remove_hidden", args: { doc: 1 } }, save], outputs: RESULT };
    case "render": {
      const dpi = intIn(options.dpi, 18, 300, "dpi", 96);
      const p = pages(options.pages, n, "pages", 50) ?? [1];
      return {
        steps: [open(0), ...p.map((page) => ({ tool: "page_render", args: { doc: 1, page, dpi }, out: `out/page-${page}.png` }))],
        outputs: p.map((page) => ({ name: `page-${page}.png`, type: "image/png" })),
      };
    }
    case "text": {
      const args = { doc: 1, format: "text" };
      const p = pages(options.pages, n);
      if (p) args.pages = p;
      return { steps: [open(0), { tool: "text_extract", args }], outputs: [{ fromReport: 1, name: "text.json", type: "application/json" }] };
    }
    case "print": {
      const args = { doc: 1, path: "out/result.pdf", grayscale: bool(options.grayscale, "grayscale", false), layout: oneOf(options.layout, ["fit", "actual", "shrink"], "layout", "fit") };
      return { steps: [open(0), { tool: "doc_print", args }], outputs: RESULT };
    }
  }
  throw new OptionError("operation", "unknown");
}


// ---- sign_complete (PW6): an e-sign envelope's completion ----
//
// The envelope's documents (in order) are combined, each signer's values placed where their fields
// are (typed text in the standard fonts, typed signatures in the script font, drawn signatures from
// the images sent with the job), flattened into the page content, followed by a certificate page,
// and the whole signed once with the platform's digital ID: PAdES B-B, SHA-256, a certification
// signature that allows no changes. The ID is the runner's (sign.p12, written for this job from the
// container's secret); a request never names a key or a path. The script then reopens the signed
// file and lists its signature, which the server checks before answering.

const KINDS = ["signature", "initials", "date", "text", "checkbox"];
const MAX_FIELDS = 200;

/** Printable Western European text (what the standard fonts draw), at most `max` characters. */
export function winAnsi(value, field, max) {
  if (typeof value !== "string") throw new OptionError(field, "text");
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/[^\u0020-\u007e\u00a0-\u00ff]/g, "?").replace(/ {2,}/g, " ").trim();
  if (!clean) throw new OptionError(field, "not empty");
  return clean.slice(0, max);
}

function num(value, lo, hi, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < lo || value > hi) throw new OptionError(field, `a number from ${lo} to ${hi}`);
  return Math.round(value * 100) / 100;
}

function rect(value, field) {
  if (!Array.isArray(value) || value.length !== 4) throw new OptionError(field, "[x, y, w, h]");
  const [x, y, w, h] = value.map((v, i) => num(v, i < 2 ? 0 : 1, 14400, `${field}[${i}]`));
  return [x, y, w, h];
}

const SHA256 = /^[0-9a-f]{64}$/;

function signComplete(options, inputs, pageCounts, extra) {
  if (inputs < 1 || inputs > 10) throw new OptionError("inputs", "sign_complete takes 1 to 10 PDFs");
  const images = Number.isInteger(extra.images) ? extra.images : 0;
  const imageNames = extra.imageNames ?? [];
  if (typeof extra.signPassword !== "string" || !extra.signPassword) throw new OptionError("signing", "no digital ID");
  const fields = options.fields;
  if (!Array.isArray(fields) || fields.length === 0 || fields.length > MAX_FIELDS) throw new OptionError("fields", `1 to ${MAX_FIELDS} filled fields`);
  const offsets = pageCounts.map((_, i) => pageCounts.slice(0, i).reduce((a, b) => a + b, 0));
  const total = pageCounts.reduce((a, b) => a + b, 0);

  const steps = [];
  if (inputs > 1) {
    steps.push({ tool: "doc_combine", args: { paths: Array.from({ length: inputs }, (_, i) => `in-${i}.pdf`), out: "combined.pdf" } });
    steps.push({ tool: "doc_open", args: { path: "combined.pdf" } });
  } else steps.push(open(0));

  fields.forEach((f, i) => {
    const at = `fields[${i}]`;
    if (!f || typeof f !== "object") throw new OptionError(at, "an object");
    const doc = intIn(f.doc, 0, inputs - 1, `${at}.doc`, 0);
    const page = intIn(f.page, 1, pageCounts[doc], `${at}.page`, undefined);
    if (page === undefined) throw new OptionError(`${at}.page`, "required");
    const kind = oneOf(f.kind, KINDS, `${at}.kind`, undefined);
    if (!kind) throw new OptionError(`${at}.kind`, "required");
    const [x, y, w, h] = rect(f.rect, `${at}.rect`);
    const args = { doc: 1, page: offsets[doc] + page };
    if (kind === "checkbox") {
      if (bool(f.checked, `${at}.checked`, false)) steps.push({ tool: "fill_sign_add", args: { ...args, type: "check", at: [x + w / 2, y + h / 2] } });
      return;
    }
    if ((kind === "signature" || kind === "initials") && f.image !== undefined) {
      const n = intIn(f.image, 0, images - 1, `${at}.image`, undefined);
      if (n === undefined || !imageNames[n]) throw new OptionError(`${at}.image`, "one of the images sent with the job");
      steps.push({ tool: "fill_sign_add", args: { ...args, type: kind, path: imageNames[n], at: [x, y + h / 2] } });
      return;
    }
    const text = winAnsi(f.text, `${at}.text`, kind === "text" ? 500 : 100);
    if (kind === "signature" || kind === "initials") steps.push({ tool: "fill_sign_add", args: { ...args, type: kind, text, at: [x, y + h / 2] } });
    else {
      const size = Math.max(6, Math.min(12, Math.round(h * 0.6)));
      steps.push({ tool: "fill_sign_add", args: { ...args, type: "text", text, font_size: size, at: [x + 2, y + Math.max(0, (h - size) / 2)] } });
    }
  });
  steps.push({ tool: "doc_flatten", args: { doc: 1, comments: true, fields: true } });

  // The certificate page.
  const c = options.certificate;
  if (!c || typeof c !== "object") throw new OptionError("certificate", "an object");
  const lines = [];
  lines.push(`Envelope: ${winAnsi(c.envelopeId, "certificate.envelopeId", 40)}`);
  lines.push(`Title: ${winAnsi(c.title, "certificate.title", 200)}`);
  lines.push(`Completed: ${winAnsi(c.completedAt, "certificate.completedAt", 40)}`);
  lines.push("");
  if (!Array.isArray(c.documents) || c.documents.length !== inputs) throw new OptionError("certificate.documents", "one entry per input");
  lines.push("Documents (SHA-256 of each as sent for signature):");
  c.documents.forEach((d, i) => {
    if (typeof d?.sha256 !== "string" || !SHA256.test(d.sha256)) throw new OptionError(`certificate.documents[${i}].sha256`, "64 hex characters");
    lines.push(`  ${i + 1}. ${winAnsi(d.name, `certificate.documents[${i}].name`, 120)} (version ${intIn(d.version, 1, 1_000_000, `certificate.documents[${i}].version`, 1)}, ${pageCounts[i]} page${pageCounts[i] === 1 ? "" : "s"})`);
    lines.push(`     ${d.sha256}`);
  });
  lines.push("");
  if (!Array.isArray(c.signers) || c.signers.length < 1 || c.signers.length > 20) throw new OptionError("certificate.signers", "1 to 20 signers");
  lines.push("Signers (each verified their email address with a one-time code):");
  c.signers.forEach((s, i) => {
    const f = `certificate.signers[${i}]`;
    lines.push(`  ${i + 1}. ${winAnsi(s?.name, `${f}.name`, 120)} <${winAnsi(s?.email, `${f}.email`, 200)}>`);
    lines.push(`     signed ${winAnsi(s?.signedAt, `${f}.signedAt`, 40)} from ${winAnsi(s?.ip ?? "unknown", `${f}.ip`, 60)}`);
  });
  lines.push("");
  if (typeof c.evidenceHead !== "string" || !SHA256.test(c.evidenceHead)) throw new OptionError("certificate.evidenceHead", "64 hex characters");
  lines.push("Evidence log head (SHA-256 of the last event before completion):");
  lines.push(`  ${c.evidenceHead}`);
  lines.push("");
  lines.push("A simple electronic signature with an audit trail, sealed by Pagewell with the digital");
  lines.push("signature on this file. It makes no claim to be an advanced or qualified signature.");

  const cert = total + 1;
  steps.push({ tool: "page_insert_blank", args: { doc: 1, at: cert, width: 612, height: 792 } });
  steps.push({ tool: "page_add_text", args: { doc: 1, page: cert, at: [54, 54], width: 504, size: 16, bold: true, text: "Certificate of completion" } });
  steps.push({ tool: "page_add_text", args: { doc: 1, page: cert, at: [54, 90], width: 504, size: 9, font: "helvetica", text: lines.join("\n") } });
  steps.push({
    tool: "sign_document",
    args: { doc: 1, id: "sign.p12", password: extra.signPassword, out: "out/result.pdf", certify: "no_changes", reason: "Completed with Pagewell e-sign", contact: "Pagewell" },
  });
  steps.push({ tool: "doc_open", args: { path: "out/result.pdf" } });
  steps.push({ tool: "sign_list", args: { doc: 2 } });
  return { steps, outputs: [...RESULT, { fromReport: steps.length - 1, name: "signature.json", type: "application/json" }], signed: { pages: cert } };
}
