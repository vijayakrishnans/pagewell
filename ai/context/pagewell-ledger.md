# Pagewell ledger

Read this first on every resume. Then the notes file
(`~/openproduct/pagewell-factory-notes.md`, outside the repo), `~/openproduct/pagewell-WAITING.md`,
`task_get pagewell-pdf-workspace`, `specs/epics/pagewell-pdf-workspace/IMPLEMENTATION-STATUS.md`,
`feature-matrix.md` and `gh pr list --state all`.

## Status (2026-11-28)

Phase A done: workspace `ws_52SNF622` in `openproduct-6ny98czp` (the user's
decision, superseding `openproduct-sms84q22`), cirrus-baseline bootstrapped
in ~6 min, stage and prod healthy. Epic EP-2 minted with PW0–PW11.
PW0 ✅, PW1 ✅, PW2 ✅ (#11–#18), PW3 ✅ (2026-11-28: #19–#25; team profile on; sharing, guests, links, audit verified on stage). Next: PW4 (heavy jobs: needs Docker, W2).

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
- 2026-11-27: the editor bridge drives upstream's host hooks (`startup_inbox`, `host_save`, `host_dirty`, the `ui.command` control channel) from its own wasm entry, plus two small upstream patches (P1, P2) (PW-B).
- 2026-11-27: the editor bundle is built by the Rust lane and pinned by `apps/editor-web` (D6); deploys never compile Rust.
- 2026-11-27: the editor's wasm is built with `profile.web` (opt-level z, rendering crates at 3, fat LTO); `wasm-opt` is not used (D7).
- 2026-11-27: e2e runs on `ubuntu-24.04` (Playwright has no 26.04 build yet), with Firefox headed under Xvfb on Mesa's software GL; the page tells users without WebGL2 why the editor can't start.

## Live URLs

- api-edge: https://pagewell-api-edge-stage.vijayakrishnan12994.workers.dev/health · https://pagewell-api-edge-prod.vijayakrishnan12994.workers.dev/health
- console: https://pagewell-web-console-next-stage.vijayakrishnan12994.workers.dev · https://pagewell-web-console-next-prod.vijayakrishnan12994.workers.dev
- repo: https://github.com/vijayakrishnans/pagewell (public)
- editor (stage): https://pagewell-editor-web-stage.vijayakrishnan12994.workers.dev/edit/local · /edit/fixture

## Milestones (Orunbase ids)

PW0 mls_QNVAF2QE · PW1 mls_3F6D2YPV · PW2 mls_3QY0GJGR · PW3 mls_48B1ECZE · PW4 mls_G729QMCQ · PW5 mls_Q1Q8HG96 · PW6 mls_NM1NY4M0 · PW7 mls_YZMHHDSE · PW8 mls_SEGB59V2 · PW9 mls_SF91KF9R · PW10 mls_BBXA7RVH · PW11 mls_50PQVMYE

## Tasks

| Key | Milestone | PR | Rung |
|---|---|---|---|
| PW-1 | PW0 | #3 (4c85ae9) | done |
| PW-2 | PW0 | #4 (c5a3f5a) | done |
| PW-3 | PW1 | #5 (8727aaa) | done |
| PW-5 | PW1 | #6 (3607bcb) | done |
| PW-6 | PW1 | #7 (2903a69) | done |
| PW-4 | PW1 | #8 (8dcfcf0) | done |
| PW-7 | PW1 | #9 (452de5d) | done |
| PW-8 | PW1 | #10 (0769a17) | done |
| PW-9 | PW2 | #11 (10ae82d) | done |
| PW-10 | PW2 | #12 (c640fa8) | done |
| PW-12 | PW2 | #13 (1263c94) | done |
| PW-13 | PW2 | #14 (83f1947) | done |
| PW-14 | PW2 | #15 (29da24b) | done |
| PW-11 | PW2 | #16 (1126f77) | done: buckets pagewell-files-stage/prod created |
| PW-15 | PW2 | #17 (a653a9c), #18 (1f4cb30) | done: files-worker live; stage e2e 44 + editor green |
| PW-16 | PW3 | #19 (4a6969e) | done: sharing data + access rules |
| PW-17 | PW3 | #20 (c9b527d) | done: files-worker sharing API |
| PW-18 | PW3 | #21 (6034fc7) | done: team profile (Solo off) |
| PW-19 | PW3 | #22 (f593d3d) | done: edge, SDK, invitations |
| PW-20 | PW3 | #23 (1de97a8) | done: console sharing UI |
| PW-21 | PW3 | #24 (f58b0af), #25 (6b17656) | done: link viewer; stage sharing 47 + live link green |
| PW-22 | PW3 | #26 (9e455a7) | done: gaps register (GAPS.md) |
| PW-23 | PW4 | — | in progress: pdf-runner image + CI |

## Measured budgets

**First load (budget ≤ 8 MB compressed): missed.** The editor wasm, brotli-11, by build (PW-8,
Rust lane size job and dispatch builds, 2026-11-27):

| Build | raw | gzip -9 | brotli 11 | 10 pages rendered, 150 dpi* |
|---|---:|---:|---:|---:|
| release (opt 3, thin LTO), names stripped | 58,032,959 | 19,993,055 | 13,019,492 | ~930 ms |
| release + `wasm-opt -Oz` | 50,154,027 | 20,168,361 | 13,390,143 | — |
| opt-level z, fat LTO | 42,164,107 | 14,592,289 | 10,272,580 | ~1,790 ms |
| opt-level z, fat LTO + `wasm-opt -Oz` | 34,763,643 | 15,299,051 | 10,726,418 | — |
| **`profile.web`: z, rendering crates at 3, fat LTO (ships)** | 44,091,794 | — | **10,666,672** | ~1,040 ms |

\* headless Chromium on SwiftShader, factory box, medians of 3 fresh contexts; interleaved runs
for the last row. `wasm-opt -Oz` shrinks the raw module but grows the compressed one, so it is
not used. The shipping profile is 2.35 MB smaller than release and ready ~0.5 s sooner, at ~10%
slower rendering. Plus 176,904 B of JS glue (26,137 gzip) and the page (< 10 KB).

**First page (budget ≤ 2 s for the 100-page fixture): missed on a first visit.** Stage, release
bundle, headless Chromium from the factory box (2026-11-27): first page 7.5 s from navigation,
13.16 MB transferred (the wasm took ~2.4 s to download). Locally (no network) the size-profile
bundle shows page 1 in ~2.3 s. A repeat visit uses the immutable cache.

Stage, size-profile bundle (`editor · stage` job of `editor-e2e` on main after #10, GitHub
runner, first visit, nothing cached):

| Browser | First page | Transferred |
|---|---:|---:|
| Chromium | 1.62 s | 10.81 MB |
| Firefox (headed, Mesa software GL) | 2.43 s | 10.81 MB |
| WebKit | 2.39 s | 10.82 MB |

Chromium is inside 2 s from a datacenter link; Firefox and WebKit are not, and a home
connection adds the download time of ~10.8 MB. Risk PW-C keeps the remaining options.

Build times: wasm release build 30m34s at `-j 2` on the factory box, ~10 min on GitHub's runner
(release), ~15 min (`profile.web`); pdfcraft-cli v0.22.0 cold release build 85m38s user time.

## Upstream patches

See `vendor/UPSTREAM-PATCHES.md`. P1 `Automation::open_bytes` (storytold/pdfcraft#8536, PR #8537);
P2 host brand (storytold/pdfcraft#8538, no PR: upstream `main` has moved its UI).

## Open risks and deferred items

See `risks-and-open-questions.md`: PW-A…PW-M; open blocker PW-M (Docker on the build machine); PW-L resolved.
