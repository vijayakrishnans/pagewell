# sign-worker

Pagewell's e-sign (milestone PW6): a **simple electronic signature with an audit trail**. No claim
of an advanced or qualified signature is made anywhere.

- **Envelopes** hold 1–10 documents, 1–20 signers (parallel, or sequential by routing order) and
  fields per signer (signature, initials, date, text, checkbox) on a page and rectangle. Making,
  sending and managing one needs `share` on every document in it (signers will see them), asked
  of files-worker as the person.
- **Sending freezes** each document at its current version: the version, the SHA-256 of its bytes
  and its page count. Signers always see that version, whatever is saved later.
- **Signers have no account.** Each gets a link (`<SIGN_URL>/s/<token>`, 14 days, a new one on
  resend or reminder) and proves the email address with a six-digit code (10 minutes, one per
  30 s, five wrong tries). Only then can they open the documents and sign their own fields. The
  date field is the day they sign, set by the server. Drawn signatures are PNGs kept in R2.
- **Completion**: when everyone has signed, the documents as sent (their hashes checked again),
  every value and a certificate go to the pdf-runner's `sign_complete` (through pdf-jobs-worker's
  internal route): values placed and flattened, a certificate page, a PAdES B-B certification
  signature with the platform's digital ID. The sealed PDF becomes a document in the sender's
  drive; everyone is emailed its SHA-256 and a 30-day download link. When the runner is not
  there, the envelope waits in `completing` and the hourly run tries again.
- **Evidence**: every step (created, sent, notified, viewed, code sent/failed, verified, signed,
  declined, voided, expired, completed) is an event in an append-only, hash-chained log
  (`@saas/shared/evidence`); `GET …/evidence` returns it with the chain's verdict.

## Routes
The sender's, under `/v1/organizations/{org}` (signed in): `GET|POST /envelopes`,
`GET|PATCH /envelopes/{env}`, `POST /envelopes/{env}/send|resend|void`, `GET /envelopes/{env}/evidence`.

The signer's, under `/v1/s/{token}` (no account): `GET /`, `POST /code`, `POST /verify`,
`GET /documents/{doc}`, `POST /submit`, `POST /decline`.
