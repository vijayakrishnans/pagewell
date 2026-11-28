-- 240_review_core
-- Pagewell review (PW5) — comment threads anchored on a page of a version, their comments, and
-- review requests with their reviewers
-- Bounded context: review
-- schema review: Pagewell's review — owns threads, comments and review requests; documents stay in files.
--
-- Every query scopes by org_id. The server is the source of truth for comments: the editor shows
-- them and sends new ones here. A thread is anchored on one page of the version it was made on;
-- when the document gets a newer version its anchor is carried forward (same page, its quote or
-- the page's text unchanged) or marked outdated, never silently moved.

CREATE TABLE IF NOT EXISTS review_threads (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  doc_id       TEXT NOT NULL,
  anchor_json  TEXT NOT NULL,
  version      INTEGER NOT NULL CHECK (version >= 1),
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'outdated')),
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  resolved_by  TEXT,
  resolved_at  TEXT
);

-- table review_threads: A comment thread on one page (and a rectangle) of a document's version.
-- column review_threads.anchor_json: {"page": n, "rect": [x, y, w, h] in points from the page's top-left, "quote": text under it or null}.
-- column review_threads.version: The version the anchor was last checked against (carried forward as versions are saved).
-- column review_threads.status: open, resolved, or outdated (its anchor no longer matches the current version).

CREATE INDEX IF NOT EXISTS review_threads_doc_idx
  ON review_threads (org_id, doc_id, created_at);

CREATE TABLE IF NOT EXISTS review_comments (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  thread_id     TEXT NOT NULL,
  author_kind   TEXT NOT NULL CHECK (author_kind IN ('member', 'guest', 'agent')),
  author_id     TEXT NOT NULL,
  author_name   TEXT,
  body          TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
  mentions_json TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL,
  edited_at     TEXT,
  deleted_at    TEXT,
  FOREIGN KEY (thread_id) REFERENCES review_threads (id)
);

-- table review_comments: The comments of a thread, oldest first. Deleting blanks a comment and keeps its place.
-- column review_comments.author_id: The public actor id (usr_/sp_) of whoever wrote it.
-- column review_comments.author_name: The email or name shown beside it, as known when it was written.
-- column review_comments.mentions_json: The email addresses @-mentioned in the body, emailed once.

CREATE INDEX IF NOT EXISTS review_comments_thread_idx
  ON review_comments (org_id, thread_id, created_at);

CREATE TABLE IF NOT EXISTS review_requests (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  doc_id        TEXT NOT NULL,
  version       INTEGER NOT NULL CHECK (version >= 1),
  message       TEXT,
  due_at        TEXT,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'canceled')),
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  reminded_at   TEXT
);

-- table review_requests: A request for people to review a document (a version of it) by a date.
-- column review_requests.reminded_at: When the last reminder went out (the cron reminds once a day before and after the due date).

CREATE INDEX IF NOT EXISTS review_requests_doc_idx
  ON review_requests (org_id, doc_id, created_at DESC);

CREATE INDEX IF NOT EXISTS review_requests_due_idx
  ON review_requests (due_at) WHERE status = 'open' AND due_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS review_request_reviewers (
  org_id        TEXT NOT NULL,
  request_id    TEXT NOT NULL,
  email         TEXT NOT NULL,
  user_id       TEXT,
  decision      TEXT CHECK (decision IN ('approved', 'changes_requested')),
  decided_at    TEXT,
  PRIMARY KEY (request_id, email),
  FOREIGN KEY (request_id) REFERENCES review_requests (id)
);

-- table review_request_reviewers: Who is asked to review, by email, and what they decided.
-- column review_request_reviewers.user_id: The account that decided (matched by the verified email it signed in with).

CREATE INDEX IF NOT EXISTS review_request_reviewers_email_idx
  ON review_request_reviewers (email);
