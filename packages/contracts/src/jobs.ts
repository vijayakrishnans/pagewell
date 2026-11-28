// Wire types for Pagewell's heavy jobs (PW4): pdf-jobs-worker, behind api-edge's
// /v1/organizations/{org}/jobs facade. A job runs one PdfCraft operation in the pdf-runner
// container on stored versions; its result becomes a new version of the document, a new
// document, or (render, text) files the job keeps for a day.

export const JOB_OPERATIONS = ["ocr", "compress", "merge", "split", "extract", "rotate", "flatten", "redact", "sanitize", "render", "text", "print"] as const;
export type JobOperation = (typeof JOB_OPERATIONS)[number];

export const JOB_STATUSES = ["queued", "running", "succeeded", "failed", "canceled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Where a job's PDF result goes: the next version of its document, or a new document beside it. */
export type JobOutputMode = "version" | "document";

/** Operations whose result replaces the document's content when `output` is "version". */
export const VERSIONING_OPERATIONS: readonly JobOperation[] = ["ocr", "compress", "rotate", "flatten", "redact", "sanitize"];
/** Operations that make new documents (merge, split, extract) or files (render, text, print). */
export const FILE_OPERATIONS: readonly JobOperation[] = ["render", "text", "print"];

export interface CreateJobRequest {
  operation: JobOperation;
  /** The documents to run on: one, or 2 to 50 for merge (in order). */
  documentIds: string[];
  /** The version of the (single) input to run on; default its current version. */
  version?: number | null;
  /** Operation options: pages, degrees, every, before, preset, dpi, force, grayscale, layout. */
  options?: Record<string, unknown>;
  /** Default "version" for the versioning operations, "document" for merge, split and extract. */
  output?: JobOutputMode;
}

export interface JobResultFile {
  name: string;
  type: string;
  size: number;
}

export interface PublicJob {
  id: string;
  orgId: string;
  operation: JobOperation;
  status: JobStatus;
  documentIds: string[];
  version: number | null;
  output: JobOutputMode | "files";
  /** On success: the documents and versions it made, or the files it keeps (render, text, print). */
  result: { documents: Array<{ id: string; version: number }>; files: JobResultFile[] } | null;
  error: { code: string; message: string } | null;
  pages: number | null;
  createdBy: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface JobResponse {
  job: PublicJob;
}

export interface ListJobsResponse {
  jobs: PublicJob[];
}

/** Error codes jobs add. A missing document, or one the caller cannot read, is still 404. */
export const JOBS_ERROR_CODES = {
  /** The org already has as many jobs running as its plan allows. 429. */
  JOBS_BUSY: "jobs_busy",
  /** The runner is not available in this environment (WAITING W4 on stage). 503. */
  RUNNER_UNAVAILABLE: "runner_unavailable",
} as const;

/** Per-plan job limits (billing entitlements), with the free tier when a plan sets none. */
export const JOBS_ENTITLEMENTS = {
  pagesPerJob: "jobs.pages_per_job",
  concurrent: "jobs.concurrent",
  cpuSecondsPerJob: "jobs.cpu_seconds_per_job",
} as const;

export const JOBS_FREE_TIER = { pagesPerJob: 200, concurrent: 2, cpuSecondsPerJob: 120, memoryMb: 1024, wallSeconds: 300 } as const;

/** How long render, text and print results are kept for download. */
export const JOB_FILES_TTL_HOURS = 24;
