export interface Env {
  PLATFORM_DB?: D1Database;
  /** pagewell-files-<env>: never public; every key under org/<orgId>/ (packages/shared r2-keys). */
  FILES_BUCKET?: R2Bucket;
  MEMBERSHIP_WORKER?: Fetcher;
  POLICY_WORKER?: Fetcher;
  BILLING_WORKER?: Fetcher;
  /** Share invitations to guests (PW3). Absent: nobody is emailed, the share still works. */
  NOTIFICATIONS_WORKER?: Fetcher;
  /** The console's origin, for the invitation's link to Shared with me. */
  CONSOLE_URL?: string;
  ENVIRONMENT: string;
}
