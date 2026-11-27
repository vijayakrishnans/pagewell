# Contributing to Pagewell

Thanks for helping. Pagewell is an [Orunbase](https://orunbase.com) desired-state
repository: every change lands through a task-carrying pull request, and
merges to `main` deploy to `stage` and `prod`.

## How a change lands

1. **A task first.** Work is tracked in Orunbase under epic
   `pagewell-pdf-workspace` (EP-2), not in this repository. Each task has a key
   (`PW-<k>`) and a contract at `tasks/PW-<k>.TaskContract.yaml`; its `affects`
   list is the ceiling on what the diff may touch.
2. **Branch on the grammar:** `orun/PW-<k>-<slug>`.
3. **Trailer on every commit:** `git commit --trailer "Orun-Task: PW-<k>"`.
4. **One task per PR.** The PR body ends with the `<!-- orun:manifest … -->`
   block naming the task, the epic and the skill revisions followed.
5. **Green before merge.** Every check passes; nothing is skipped or
   quarantined to get there.

The design of record is `specs/epics/pagewell-pdf-workspace/`. If code and spec
disagree, fix the spec in the same PR.

## Local gates

```bash
pnpm install && pnpm typecheck && pnpm lint && pnpm test && pnpm build
cargo fmt --check && cargo clippy --workspace -- -D warnings && cargo test --workspace   # from PW1
orun validate --intent intent.yaml
```

## Rules that matter here

- **Tenancy is the security boundary.** Every row, R2 key (`org/<orgId>/…`),
  queue message, Durable Object, vector and job is scoped to one org, with a
  cross-org isolation test.
- **No real documents** in fixtures, logs, screenshots or CI artefacts. Generate
  fixtures.
- **Don't fork the engine.** PdfCraft lives in `vendor/pdfcraft/` as a pinned
  subtree. Product code goes in `crates/pagewell-*` and the workers; an
  unavoidable upstream change is minimal, listed in `vendor/UPSTREAM-PATCHES.md`
  and offered upstream.
- **Brand.** No ArtCraft or PdfCraft marks on user-visible surfaces; "built on
  PdfCraft" in prose is fine.
- **No secrets** in commits, logs or PR bodies.

By contributing you agree that your contribution is licensed under Apache-2.0.
