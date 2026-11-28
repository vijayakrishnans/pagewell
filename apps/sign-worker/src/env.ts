export interface Env {
  PLATFORM_DB?: D1Database;
  /** The drive: access checks, frozen versions, the signed document and its download link, as the person. */
  FILES_WORKER?: Fetcher;
  NOTIFICATIONS_WORKER?: Fetcher;
  /** pdf-jobs-worker: its internal route hands the completion to the pdf-runner container. */
  JOBS_WORKER?: Fetcher;
  /** Drawn signatures (PNG), under org/<org>/sign/<envelope>/. */
  FILES_BUCKET?: R2Bucket;
  /** The signing page's origin (the editor's), for links in emails: <SIGN_URL>/s/<token>. */
  SIGN_URL?: string;
  /** "true" on dev and stage only: links and email codes come back in the response, for tests. */
  DEBUG_DELIVERY?: string;
  ENVIRONMENT: string;
}
