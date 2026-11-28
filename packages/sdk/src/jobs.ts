import type { CreateJobRequest, JobResponse, ListJobsResponse } from "@saas/contracts/jobs";

import type { RequestOptions, Transport } from "./transport.js";

/**
 * Pagewell's heavy jobs (PW4): OCR, compress, merge, split, extract, rotate, flatten, redact,
 * sanitize, render, text, print, run in the pdf-runner container on stored versions. A job is
 * started (202, queued) and then polled until it succeeds or fails. Maps to
 * `apps/pdf-jobs-worker` through api-edge's jobs facade.
 */
export class JobsClient {
  constructor(private readonly transport: Transport) {}

  private base(orgId: string): string {
    return `/v1/organizations/${encodeURIComponent(orgId)}/jobs`;
  }

  /** Start a job. The response's job is queued; poll `get` for its end. */
  create(orgId: string, body: CreateJobRequest, opts: RequestOptions = {}): Promise<JobResponse> {
    return this.transport.request<JobResponse>({ method: "POST", path: this.base(orgId), body }, opts);
  }

  get(orgId: string, jobId: string, opts: RequestOptions = {}): Promise<JobResponse> {
    return this.transport.request<JobResponse>({ method: "GET", path: `${this.base(orgId)}/${encodeURIComponent(jobId)}` }, opts);
  }

  /** A document's jobs, or (without documentId) the caller's own. */
  list(orgId: string, query: { documentId?: string } = {}, opts: RequestOptions = {}): Promise<ListJobsResponse> {
    return this.transport.request<ListJobsResponse>({ method: "GET", path: this.base(orgId), query: { documentId: query.documentId } }, opts);
  }

  cancel(orgId: string, jobId: string, opts: RequestOptions = {}): Promise<JobResponse> {
    return this.transport.request<JobResponse>({ method: "POST", path: `${this.base(orgId)}/${encodeURIComponent(jobId)}/cancel` }, opts);
  }

  /** A render, text or print result file, for a day after the job. */
  file(orgId: string, jobId: string, name: string, opts: RequestOptions = {}): Promise<Response> {
    return this.transport.send({ method: "GET", path: `${this.base(orgId)}/${encodeURIComponent(jobId)}/files/${encodeURIComponent(name)}` }, opts);
  }

  /** Poll a job until it is no longer queued or running (or `timeoutMs` passes). */
  async wait(orgId: string, jobId: string, opts: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<JobResponse["job"]> {
    const interval = opts.intervalMs ?? 1500;
    const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
    for (;;) {
      const { job } = await this.get(orgId, jobId);
      if (job.status !== "queued" && job.status !== "running") return job;
      if (Date.now() > deadline) return job;
      if (opts.signal?.aborted) return job;
      await new Promise((r) => setTimeout(r, interval));
    }
  }
}
