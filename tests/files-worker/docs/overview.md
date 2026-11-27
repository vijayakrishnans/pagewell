# files-worker-tests

The drive's tests (PW-10). `src/harness.ts` stands up the files worker's real router over
a real SQLite engine (every migration applied, as on D1), an in-memory R2 bucket that keeps
multipart parts, the real policy engine behind a fake policy-worker, and a membership fake
that knows which user belongs to which org. Every PDF is generated in the test; nothing
here is a real document.
