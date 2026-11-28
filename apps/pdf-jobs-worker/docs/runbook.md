# pdf-jobs-worker — runbook

## Common failures
- **`503 runner_unavailable` on every POST /jobs**: no runner is bound. On stage and prod this is
  expected until the Containers grant (WAITING W4); locally, set `RUNNER_URL` to a running
  `containers/pdf-runner`.
- **A job fails with `not_found`**: the person it acts for can no longer read the document (moved
  to the trash, unshared, or removed as a guest). Nothing was written.
- **A job fails with `version_conflict`**: someone saved the document while the job ran. The job
  saved nothing; run it again on the new version.
- **A job fails with `limit_exceeded`**: the document is over the plan's page limit, or the job ran
  out of CPU, memory or time in the runner.
- **Jobs stuck `running`**: the hourly sweep fails jobs running for more than 20 minutes
  (`runner_lost`).

## Data
Rows: `jobs_jobs` in the shared D1 database. Result files: `org/<orgId>/jobs/<jobId>/out/…` in R2,
removed after a day by the sweep. Never copy a customer's document out of R2 for debugging.
