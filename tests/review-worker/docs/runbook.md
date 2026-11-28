# review-worker-tests — runbook

- **A test gets 404 where it should comment**: the drive refused the person; check the role or
  grant the test sets up.
- **Room tests**: `FakeState` stands in for the Durable Object state; `FakeSocket` records what was
  sent. Keep them to the parts of the API `room.ts` uses.
