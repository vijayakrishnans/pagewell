-- 220_jobs_core
-- Pagewell heavy jobs (PW4) — one row per PdfCraft operation run in the pdf-runner container
-- Bounded context: jobs
-- schema jobs: Pagewell's heavy jobs — owns the job rows; documents and versions stay in files.
--
-- Every query scopes by org_id. A job names its inputs (documents and the version it read) and,
-- when done, what it made (new versions or documents, or result files kept for a day). The job
-- never stores document text; errors are bounded codes and short messages.

CREATE TABLE IF NOT EXISTS jobs_jobs (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  operation     TEXT NOT NULL CHECK (operation IN ('ocr', 'compress', 'merge', 'split', 'extract', 'rotate', 'flatten', 'redact', 'sanitize', 'render', 'text', 'print')),
  status        TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled')),
  inputs_json   TEXT NOT NULL,
  options_json  TEXT NOT NULL DEFAULT '{}',
  output_mode   TEXT NOT NULL CHECK (output_mode IN ('version', 'document', 'files')),
  result_json   TEXT,
  error_code    TEXT,
  error_message TEXT,
  pages         INTEGER,
  attempts      INTEGER NOT NULL DEFAULT 0,
  created_by    TEXT NOT NULL,
  actor_kind    TEXT NOT NULL CHECK (actor_kind IN ('user', 'agent', 'mcp', 'api')),
  actor_email   TEXT,
  created_at    TEXT NOT NULL,
  started_at    TEXT,
  finished_at   TEXT,
  expires_at    TEXT
);

-- table jobs_jobs: One heavy PDF operation (OCR, compress, merge…) on stored versions, run in the pdf-runner container.
-- column jobs_jobs.inputs_json: [{"docId": "<uuid>", "version": n}] in order; the version is fixed when the job is created.
-- column jobs_jobs.result_json: {"documents": [{"docId","version"}], "files": [{"name","type","size","r2Key"}]} once it succeeded.
-- column jobs_jobs.created_by: The public actor id (usr_/sp_) the job acts as: its reads and writes go through files-worker as that actor.
-- column jobs_jobs.actor_email: The verified email of that actor, so a guest's job keeps the access shared with that email.
-- column jobs_jobs.expires_at: When result files (render, text, print) are removed.

CREATE INDEX IF NOT EXISTS jobs_jobs_org_created_idx
  ON jobs_jobs (org_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS jobs_jobs_org_active_idx
  ON jobs_jobs (org_id, status) WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS jobs_jobs_expires_idx
  ON jobs_jobs (expires_at) WHERE expires_at IS NOT NULL;
