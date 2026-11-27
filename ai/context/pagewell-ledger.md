# Pagewell ledger

Read this first on every resume. Then the notes file
(`~/openproduct/pagewell-factory-notes.md`, outside the repo), `~/openproduct/pagewell-WAITING.md`,
`task_get pagewell-pdf-workspace`, `specs/epics/pagewell-pdf-workspace/IMPLEMENTATION-STATUS.md`,
`feature-matrix.md` and `gh pr list --state all`.

## Status (2026-11-27)

Phase A done: workspace `ws_52SNF622` in `openproduct-6ny98czp` (the user's
decision, superseding `openproduct-sms84q22`), cirrus-baseline bootstrapped
in ~6 min, stage and prod healthy. Epic EP-2 minted with PW0–PW11. PW0:
PW-1 done (#3), PW-2 in review. Next: PW1 (editor on the web).

## Inputs actually used

| Input | Value |
|---|---|
| Account | `openproduct-6ny98czp` / `ws_6NY98CZP` (user's choice 2026-11-27; the brief's `ws_SMS84Q22` was not accessible) |
| Workspace | `Pagewell` / `pagewell` = `ws_52SNF622` (`org_36c20281c4bd4c5aae5ddb672ccb83bf`), public |
| Cloudflare connection | `int_4da7181983a946dbbc3bb62a9aae9a6c` (Vijayakrishnan12994's account); `nexo` is revoked in this account |
| workers.dev subdomain | `vijayakrishnan12994` (verified against a live product on the same connection) |
| GitHub connection | `int_e4aad5421dea4f2c85f65f75f05e9faf` → `GITHUB_OWNER=vijayakrishnans` |
| Repo | `vijayakrishnans/pagewell` (public) |
| Baseline | `cirrus-baseline` `baseline-v28` (successor of retired `cirrus`; PW-K) |
| `PDFCRAFT_REF` | `storytold/pdfcraft` `v0.22.0` = `ac140f809d554981a5276d748e6193fcf4d4bdfa` |
| Domain | `pagewell.app` not registered; not passed to the build (workers.dev until it exists) |
| Epic | `pagewell-pdf-workspace` = EP-2 (`epc_AVSWKTJE`), cluster `PW` (PW0–PW11) |

## Skill revisions run under (skills_list, 2026-11-27)

| Skill | rev |
|---|---|
| orunbase | `sha256:fe17c72a27677ad7935fb59f4e74076038d5bf6f95639eebcbaf175087f32404` |
| software-factory | `sha256:ac5be0858451337cddf64fe65be336be119dd17a5d11aff776c918b73af1dc35` (same as the prompt's pin) |
| orun-cli | `sha256:8c475ab27e312b0f7bf78453bab1ee64d9c8f77d033a3c9986a654b85ec229d9` |
| planning | `sha256:6caf76f6fc7099f355761e45d23afcaf59ccc7b8458af81def0b4d95f49c0f63` |
| design-authoring | `sha256:e6ed5ba1b93ec7d9f2900fcae69b7e7b54db92094f4f1a60f746f38c1c3ed975` |
| initiative-lifecycle | `sha256:9ed675c8927140e4aee5f64cc21521cf1889af9d45b86b89dee68d92b3a13085` |
| milestone-loop | `sha256:8a814c285a9f30d0a4d2c91521ac513aed0f532ff18bdc3fb4e30ccf840c2293` |
| task-branch-pr | `sha256:83c7d906a21d7919290364e9e5fa429b84947cab4f70c7083f456c80f1f6ebfd` |
| pr-provenance | `sha256:ea0af746b15ef259878c1573ea57faf427f160a43f7cfcbf94516a434f682b43` |
| mcp-tools | `sha256:d070d616a00b1fe03e17062e1daf4c95d05509090b2b563f9a511f268938e73a` |

## Decisions

- 2026-11-27: milestone table pre-approved by the user in the prompt.
- 2026-11-27: build on `cirrus-baseline` v28, not retired `cirrus` (PW-K).
- 2026-11-27: `PDFCRAFT_REF = v0.22.0`, the latest release; licence taken under Apache-2.0.
- 2026-11-27: the editor bridge uses upstream's existing host mode (`data-host="page"`, `pdfcraft:open|save|dirty|ready`) rather than a new upstream hook (PW-B).

## Live URLs

- api-edge: https://pagewell-api-edge-stage.vijayakrishnan12994.workers.dev/health · https://pagewell-api-edge-prod.vijayakrishnan12994.workers.dev/health
- console: https://pagewell-web-console-next-stage.vijayakrishnan12994.workers.dev · https://pagewell-web-console-next-prod.vijayakrishnan12994.workers.dev
- repo: https://github.com/vijayakrishnans/pagewell (public)

## Milestones (Orunbase ids)

PW0 mls_QNVAF2QE · PW1 mls_3F6D2YPV · PW2 mls_3QY0GJGR · PW3 mls_48B1ECZE · PW4 mls_G729QMCQ · PW5 mls_Q1Q8HG96 · PW6 mls_NM1NY4M0 · PW7 mls_YZMHHDSE · PW8 mls_SEGB59V2 · PW9 mls_SF91KF9R · PW10 mls_BBXA7RVH · PW11 mls_50PQVMYE

## Tasks

| Key | Milestone | PR | Rung |
|---|---|---|---|
| PW-1 | PW0 | #3 (4c85ae9) | done |
| PW-2 | PW0 | (this PR) | in review |

## Measured budgets

None yet (PW1). pdfcraft-cli v0.22.0 cold release build: 85m38s user time on the factory box.

## Upstream patches

None.

## Open risks and deferred items

See `risks-and-open-questions.md`: PW-A…PW-M; open blocker PW-M (Docker on the build machine); PW-L resolved.
