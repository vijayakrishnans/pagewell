# sign-worker — runbook

## Common failures
- **An envelope stays in "completing"**: the pdf-runner is not reachable (on stage until WAITING
  W4 clears) or failed. The hourly run retries envelopes stuck over five minutes; the evidence log
  has `envelope.completion_failed` with the runner's code when it answered with an error.
  `a document no longer matches its hash` means a frozen version's bytes changed: investigate,
  never re-send silently.
- **A signer says the link does not work**: it expired, was replaced by a resend or a reminder,
  or was spent (signed or declined), or the envelope was declined, voided or expired. Resend from
  the envelope.
- **No code arrives**: one code per 30 seconds; five wrong tries spend a code; ask for a new one.
- **`signing_unavailable` from the runner**: the container has no `SIGN_P12_B64` /
  `SIGN_P12_PASSWORD`.

## Data and secrets
Rows: `sign_envelopes`, `sign_envelope_documents`, `sign_signers`, `sign_fields`, `sign_events`
(append-only, triggers refuse changes). Drawn signatures: R2 `org/<org>/sign/<envelope>/<field>.png`.
Link tokens and codes are stored only as SHA-256 hashes and never logged. `DEBUG_DELIVERY` is
`true` only on dev and stage (links and codes come back in responses, for tests); `false` in prod.
