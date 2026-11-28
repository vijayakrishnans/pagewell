-- 250_sign_core
-- Pagewell e-sign (PW6) — envelopes, their documents (versions frozen at send), signers with
-- single-use links and email codes, fields per signer, and the hash-chained evidence log
-- Bounded context: sign
-- schema sign: Pagewell's simple electronic signature — owns envelopes, signers, fields and evidence; documents stay in files.
--
-- Every query scopes by org_id, except the public signing route's lookup of a signer by the hash
-- of their link token, which hands back a row that carries its org. Tokens and email codes are
-- stored only as SHA-256 hashes. Evidence rows are append-only (triggers refuse UPDATE and
-- DELETE) and chained: each row's hash covers the previous row's hash.

CREATE TABLE IF NOT EXISTS sign_envelopes (
  id                 TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL,
  title              TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  message            TEXT CHECK (message IS NULL OR length(message) <= 2000),
  status             TEXT NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'sent', 'completing', 'completed', 'declined', 'expired', 'voided')),
  order_mode         TEXT NOT NULL DEFAULT 'parallel' CHECK (order_mode IN ('parallel', 'sequential')),
  expires_at         TEXT,
  reminder_days      INTEGER CHECK (reminder_days IS NULL OR reminder_days BETWEEN 1 AND 30),
  created_by         TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  sent_at            TEXT,
  finished_at        TEXT,
  void_reason        TEXT,
  completion_job_id  TEXT,
  completed_doc_id   TEXT,
  completed_version  INTEGER
);

-- table sign_envelopes: A request for signatures on one or more documents, from one or more signers.
-- column sign_envelopes.status: draft (editable), sent, completing (all signed, the signed PDF is being made), completed, declined, expired or voided.
-- column sign_envelopes.order_mode: parallel (everyone at once) or sequential (by routing order, one wave at a time).
-- column sign_envelopes.reminder_days: Remind signers who have not signed every this many days (null: never).
-- column sign_envelopes.completed_doc_id: The drive document that holds the signed PDF, once completed.

CREATE INDEX IF NOT EXISTS sign_envelopes_org_idx ON sign_envelopes (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sign_envelopes_expiry_idx ON sign_envelopes (expires_at) WHERE status = 'sent' AND expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS sign_envelope_documents (
  org_id       TEXT NOT NULL,
  envelope_id  TEXT NOT NULL,
  doc_id       TEXT NOT NULL,
  position     INTEGER NOT NULL CHECK (position >= 0),
  name         TEXT NOT NULL,
  version      INTEGER CHECK (version IS NULL OR version >= 1),
  sha256       TEXT,
  page_count   INTEGER,
  PRIMARY KEY (envelope_id, doc_id),
  FOREIGN KEY (envelope_id) REFERENCES sign_envelopes (id)
);

-- table sign_envelope_documents: The documents of an envelope, in order. Version, hash and page count are frozen when it is sent.
-- column sign_envelope_documents.sha256: The SHA-256 of the frozen version's bytes, as sent (on the certificate page and in the evidence).

CREATE TABLE IF NOT EXISTS sign_signers (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL,
  envelope_id       TEXT NOT NULL,
  name              TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  email             TEXT NOT NULL,
  routing_order     INTEGER NOT NULL DEFAULT 1 CHECK (routing_order BETWEEN 1 AND 50),
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'notified', 'viewed', 'signed', 'declined')),
  token_hash        TEXT,
  token_expires_at  TEXT,
  otp_hash          TEXT,
  otp_expires_at    TEXT,
  otp_attempts      INTEGER NOT NULL DEFAULT 0,
  verified_at       TEXT,
  notified_at       TEXT,
  viewed_at         TEXT,
  signed_at         TEXT,
  declined_at       TEXT,
  decline_reason    TEXT,
  ip                TEXT,
  user_agent        TEXT,
  reminded_at       TEXT,
  FOREIGN KEY (envelope_id) REFERENCES sign_envelopes (id)
);

-- table sign_signers: Who signs an envelope, in what order, and how far they got.
-- column sign_signers.token_hash: SHA-256 of the signer's current link token (null once signed, declined, voided, or before their turn).
-- column sign_signers.otp_hash: SHA-256 of the email code they were sent; 5 wrong tries end it.
-- column sign_signers.verified_at: When they proved the email address with the code (needed to sign).
-- column sign_signers.ip: The address they signed or declined from (on the certificate page).

CREATE UNIQUE INDEX IF NOT EXISTS sign_signers_token_idx ON sign_signers (token_hash) WHERE token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS sign_signers_envelope_idx ON sign_signers (org_id, envelope_id, routing_order);

CREATE TABLE IF NOT EXISTS sign_fields (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  envelope_id  TEXT NOT NULL,
  signer_id    TEXT NOT NULL,
  doc_id       TEXT NOT NULL,
  page         INTEGER NOT NULL CHECK (page >= 1),
  rect_json    TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('signature', 'initials', 'date', 'text', 'checkbox')),
  required     INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0, 1)),
  label        TEXT,
  value_json   TEXT,
  filled_at    TEXT,
  FOREIGN KEY (envelope_id) REFERENCES sign_envelopes (id),
  FOREIGN KEY (signer_id) REFERENCES sign_signers (id)
);

-- table sign_fields: A place on a page of an envelope's document for one signer to fill.
-- column sign_fields.rect_json: [x, y, w, h] in points from the page's top-left.
-- column sign_fields.value_json: What the signer put there: {"text"} for text, date and typed signatures, {"checked"}, or {"imageKey"} for a drawn signature kept in R2.

CREATE INDEX IF NOT EXISTS sign_fields_envelope_idx ON sign_fields (org_id, envelope_id, signer_id);

CREATE TABLE IF NOT EXISTS sign_events (
  org_id        TEXT NOT NULL,
  envelope_id   TEXT NOT NULL,
  seq           INTEGER NOT NULL CHECK (seq >= 1),
  kind          TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  at            TEXT NOT NULL,
  prev_hash     TEXT NOT NULL,
  hash          TEXT NOT NULL,
  PRIMARY KEY (envelope_id, seq),
  FOREIGN KEY (envelope_id) REFERENCES sign_envelopes (id)
);

-- table sign_events: The envelope's evidence log, append-only: each row's hash is SHA-256 over the previous hash and this row.
-- column sign_events.prev_hash: The previous row's hash (64 zeros for the first).
-- column sign_events.hash: sha256(prev_hash, seq, kind, at, canonical payload), see @saas/shared/evidence.

CREATE TRIGGER IF NOT EXISTS sign_events_no_update BEFORE UPDATE ON sign_events
BEGIN
  SELECT RAISE(ABORT, 'sign_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS sign_events_no_delete BEFORE DELETE ON sign_events
BEGIN
  SELECT RAISE(ABORT, 'sign_events is append-only');
END;
