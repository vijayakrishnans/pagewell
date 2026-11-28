export interface Env {
  PLATFORM_DB?: D1Database;
  /** The drive: every access check, text read and share goes through it, as the person asking. */
  FILES_WORKER?: Fetcher;
  NOTIFICATIONS_WORKER?: Fetcher;
  /** One DocRoom per document: presence, the edit lease, live comments. */
  DOC_ROOM?: DurableObjectNamespace;
  /** The editor's origin, for links in review emails. */
  EDITOR_URL?: string;
  ENVIRONMENT: string;
}
