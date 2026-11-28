// pdf-runner's operations (PW4): each one is a fixed pdfcraft-cli script over files the runner
// names itself (in-0.pdf, in-1.pdf … and out/…). Nothing from a request becomes a path: options
// are validated into numbers, booleans and enums, and every path below is a literal. The CLI then
// runs with --root <jobdir>, which refuses any path outside the job's directory as well.

export const OPERATIONS = ["ocr", "compress", "merge", "split", "extract", "rotate", "flatten", "redact", "sanitize", "render", "text", "print"];

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
export function plan(operation, options = {}, inputs = 1, pageCounts = [1]) {
  if (!OPERATIONS.includes(operation)) throw new OptionError("operation", `one of ${OPERATIONS.join(", ")}`);
  if (options === null || typeof options !== "object" || Array.isArray(options)) throw new OptionError("options", "an object");
  const n = pageCounts[0] ?? 1;
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
