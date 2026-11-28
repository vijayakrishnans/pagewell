# sign-worker-tests

Tests for `apps/sign-worker` (PW6), run against the **real** files-worker router in process on real
SQLite, so every envelope meets the drive's own rights. The pdf-runner is replaced by a fake
pdf-jobs-worker that records what it was sent and answers with a stand-in PDF (the real
`sign_complete` is tested on the runner image, PW-32). Links and codes come back in responses
(`DEBUG_DELIVERY`), as on stage.

Run: `pnpm --filter @saas/sign-worker-tests test`.
