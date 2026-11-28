# files-worker — runbook

## How it deploys
Merges to `main` converge through the component lanes like every worker: stage and prod
deploy on push to `main`. `FILES_BUCKET` is bound to `pagewell-files-<env>`, whose name the
`cloudflare-r2` Terraform root publishes as `WIRING_CLOUDFLARE_R2` (rendered into
`wrangler.jsonc` from `wrangler.template.jsonc`; `wiring.fixture.json` stands in offline).

## Verify
`tests/files-worker` drives every route against a real SQLite engine and an in-memory R2,
including cross-org isolation. On stage, the drive's end-to-end run goes through `api-edge`.

## Common failures
- **`503` on every route**: `PLATFORM_DB` or `FILES_BUCKET` is not bound. Check the rendered
  `wrangler.jsonc` and that the bucket exists.
- **Every route `404` for a member**: membership-worker or policy-worker is unreachable, or
  policy has no `files.*` actions (policy-engine older than PW-10). Authorization fails
  closed, and closed is a `404`.
- **`402 quota_exceeded`**: the org's plan limit, or the free tier when the plan sets none.
  `GET /quota` shows used and limit.
- **Uploads stuck**: unfinished multipart uploads expire after 24 h; the 03:17 UTC cron aborts
  them.

## Data
Rows: `files_folders`, `files_documents`, `files_versions`, `files_uploads` in the shared D1
database. Bytes: `org/<orgId>/doc/<docId>/blob|thumb|text/…` in R2. Never copy a customer's
document out of R2 for debugging; use the generated fixtures.
