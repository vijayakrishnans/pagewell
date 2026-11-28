# pdf-jobs-worker-tests

Tests for `apps/pdf-jobs-worker` (PW4). Jobs run against the **real** files-worker router (in
process, on real SQLite with every migration applied, and an in-memory R2), so a job's reads and
writes meet the drive's own rights, quotas, version conflicts and audit. The pdf-runner container
is replaced by a fake that answers its `POST /run` protocol; the runner itself is tested inside
its image in CI (`.github/workflows/pdf-runner.yml`).

Run: `pnpm --filter @saas/pdf-jobs-worker-tests test`.
