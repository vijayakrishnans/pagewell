export interface Env {
  PLATFORM_DB?: D1Database;
  /** pagewell-files-<env>: never public; every key under org/<orgId>/ (packages/shared r2-keys). */
  FILES_BUCKET?: R2Bucket;
  MEMBERSHIP_WORKER?: Fetcher;
  POLICY_WORKER?: Fetcher;
  BILLING_WORKER?: Fetcher;
  ENVIRONMENT: string;
}
