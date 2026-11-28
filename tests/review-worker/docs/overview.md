# review-worker-tests

Tests for `apps/review-worker` (PW5), run against the **real** files-worker router in process on
real SQLite, so every comment and request meets the drive's own rights. The DocRoom is driven
through its methods with an in-memory Durable Object state and fake sockets (Node cannot open a
real 101 WebSocket).

Run: `pnpm --filter @saas/review-worker-tests test`.
