# files-worker-tests — runbook

Run: `pnpm --dir tests/files-worker test`. Needs Node 22 (`node:sqlite`).
A failure in the cross-org suite is a tenancy bug: treat it as a security issue, not a flake.
