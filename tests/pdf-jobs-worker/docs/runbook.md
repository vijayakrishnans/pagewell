# pdf-jobs-worker-tests — runbook

- **A test fails with a 404 where a job should run**: the drive refused the person the job acts
  as. Check the role or grant the test sets up; jobs see exactly what the drive lets that person see.
- **Jobs stay queued in a test**: the test's `dispatch` captures jobs; run them with `runQueued`.
- **The fake runner disagrees with the real one**: the protocol is in
  `containers/pdf-runner/server.mjs`; keep `fakeRunner` in `src/harness.ts` to it.
