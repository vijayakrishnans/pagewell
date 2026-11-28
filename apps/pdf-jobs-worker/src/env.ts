export interface Env {
  PLATFORM_DB?: D1Database;
  /** pagewell-files-<env>: result files of render, text and print jobs, under org/<orgId>/jobs/. */
  FILES_BUCKET?: R2Bucket;
  /** The drive. Every read and write a job makes goes through it, as the person who asked. */
  FILES_WORKER?: Fetcher;
  BILLING_WORKER?: Fetcher;
  /** One Durable Object per job: it runs the job from an alarm and retries it. */
  JOB_RUNNER?: DurableObjectNamespace;
  /**
   * The pdf-runner container (Cloudflare Containers). Not bound until the Containers grant
   * exists (WAITING W4); without it, RUNNER_URL, else jobs are refused as runner_unavailable.
   */
  PDF_RUNNER?: DurableObjectNamespace;
  /** A pdf-runner reachable over HTTP (local and test runs). */
  RUNNER_URL?: string;
  ENVIRONMENT: string;
}
