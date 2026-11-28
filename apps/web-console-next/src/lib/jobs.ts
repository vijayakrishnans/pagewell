/**
 * Heavy jobs in the console (PW4): pure helpers for the Run a tool dialog and the jobs tray.
 * Dependency-free so they are unit-testable (tests/web-console-next/src/jobs.test.ts).
 */

import type { CreateJobRequest, JobOperation, JobOutputMode, PublicJob } from "@saas/contracts/jobs";

export interface ToolChoice {
  operation: JobOperation;
  label: string;
  description: string;
  /** What the person is asked for. */
  asks: Array<"degrees" | "pages" | "every" | "preset" | "merge-with">;
  /** Can its result be either the next version or a new document? */
  versioning: boolean;
}

export const TOOLS: readonly ToolChoice[] = [
  { operation: "ocr", label: "Recognize text (OCR)", description: "Make scanned pages searchable and selectable.", asks: ["pages"], versioning: true },
  { operation: "compress", label: "Compress", description: "Make the file smaller.", asks: ["preset"], versioning: true },
  { operation: "rotate", label: "Rotate pages", description: "Turn pages by 90, 180 or 270 degrees.", asks: ["degrees", "pages"], versioning: true },
  { operation: "flatten", label: "Flatten forms and comments", description: "Bake form fields and comments into the pages.", asks: [], versioning: true },
  { operation: "redact", label: "Apply redactions", description: "Remove what the redaction marks cover, for good.", asks: ["pages"], versioning: true },
  { operation: "sanitize", label: "Remove hidden information", description: "Strip metadata, attachments, scripts and other hidden content.", asks: [], versioning: true },
  { operation: "extract", label: "Extract pages", description: "Copy some pages into a new document.", asks: ["pages"], versioning: false },
  { operation: "split", label: "Split", description: "Cut into several documents, every N pages.", asks: ["every"], versioning: false },
  { operation: "merge", label: "Merge with…", description: "Combine with other documents into a new one.", asks: ["merge-with"], versioning: false },
  { operation: "render", label: "Page images", description: "PNG images of pages, kept for a day.", asks: ["pages"], versioning: false },
  { operation: "text", label: "Extract text", description: "The text of every page, kept for a day.", asks: [], versioning: false },
  { operation: "print", label: "Print-ready PDF", description: "A server-rendered PDF to print, kept for a day.", asks: [], versioning: false },
];

export const toolFor = (op: JobOperation): ToolChoice => TOOLS.find((t) => t.operation === op)!;

/** "1, 3-5" → [1, 3, 4, 5]; null when the text isn't a page list within 1..max. */
export function parsePages(text: string, max: number): number[] | null {
  const out = new Set<number>();
  const parts = text.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  for (const part of parts) {
    const m = part.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) return null;
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : from;
    if (from < 1 || to < from || to > max) return null;
    for (let p = from; p <= to; p++) out.add(p);
  }
  return [...out].sort((a, b) => a - b);
}

export interface ToolForm {
  degrees?: 90 | 180 | 270;
  pages?: string;
  every?: number;
  preset?: "standard" | "mobile";
  mergeWith?: string[];
  output?: JobOutputMode;
}

/** The job to start, or what is wrong with the form. */
export function jobRequest(op: JobOperation, docId: string, pageCount: number | null, form: ToolForm): { ok: true; request: CreateJobRequest } | { ok: false; error: string } {
  const max = pageCount ?? 10_000;
  const options: Record<string, unknown> = {};
  if (op === "rotate") options.degrees = form.degrees ?? 90;
  if (op === "compress") options.preset = form.preset ?? "standard";
  if (op === "ocr") options.force = true;
  if (op === "render") options.dpi = 96;
  if (form.pages && form.pages.trim()) {
    const pages = parsePages(form.pages, max);
    if (!pages) return { ok: false, error: `Pages: numbers and ranges from 1 to ${max}, like 1, 3-5` };
    if (op === "render" && pages.length > 50) return { ok: false, error: "Page images: at most 50 pages at a time" };
    options.pages = pages;
  } else if (op === "extract") {
    return { ok: false, error: "Which pages to extract?" };
  } else if (op === "render") {
    options.pages = [1];
  }
  if (op === "split") {
    const every = form.every ?? 1;
    if (!Number.isInteger(every) || every < 1 || every > max) return { ok: false, error: `Split every 1 to ${max} pages` };
    options.every = every;
  }
  const documentIds = op === "merge" ? [docId, ...(form.mergeWith ?? [])] : [docId];
  if (op === "merge" && documentIds.length < 2) return { ok: false, error: "Choose at least one document to merge with" };
  const request: CreateJobRequest = { operation: op, documentIds, options };
  if (toolFor(op).versioning) request.output = form.output ?? "version";
  return { ok: true, request };
}

export const isActive = (job: Pick<PublicJob, "status">) => job.status === "queued" || job.status === "running";

/** One line about a job, for the tray and the toast. */
export function jobSummary(job: PublicJob): string {
  const label = toolFor(job.operation)?.label ?? job.operation;
  switch (job.status) {
    case "queued":
      return `${label}: waiting to start`;
    case "running":
      return `${label}: working…`;
    case "succeeded":
      if (job.result?.files.length) return `${label}: ready`;
      if (job.output === "version") return `${label}: saved as version ${job.result?.documents[0]?.version ?? "?"}`;
      return `${label}: made ${job.result?.documents.length ?? 0} document${job.result?.documents.length === 1 ? "" : "s"}`;
    case "failed":
      return `${label} failed: ${job.error?.message ?? "unknown error"}`;
    case "canceled":
      return `${label}: canceled`;
  }
}

/** The file a finished job offers to open, if any (print → the PDF, text → JSON, render → page 1). */
export function primaryFile(job: PublicJob): string | null {
  const files = job.result?.files ?? [];
  return files.find((f) => f.name === "result.pdf")?.name ?? files[0]?.name ?? null;
}
