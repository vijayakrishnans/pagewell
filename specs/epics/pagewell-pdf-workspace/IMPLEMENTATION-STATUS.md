# pagewell-pdf-workspace (PW) — Implementation status

As-built ≠ intent. This file records what actually shipped, and every place
the code departed from `design.md`.

| Milestone | State | PR |
|---|---|---|
| PW0 — the spec | ✅ done 2026-11-27 (PW-1 doc set; PW-2 public, listing-ready repo) | #3, #4 |
| PW1 — editor on the web | ✅ done 2026-11-28: vendor subtree (PW-3), upstream hooks P1/P2 (PW-5, PW-6), Rust workspace + bridge (PW-4), editor-web on stage (PW-7), three browsers, budgets, brand check (PW-8). Both budgets missed and recorded (risk PW-C) | #5, #6, #7, #8, #9, #10 |
| PW2 — drive | | |
| PW3 — orgs and sharing | | |
| PW4 — heavy jobs | | |
| PW5 — review | | |
| PW6 — e-sign | | |
| PW7 — remote MCP | | |
| PW8 — chat with documents | | |
| PW9 — edit by chat | | |
| PW10 — Spaces-lite | | |
| PW11 — prod, docs, launch | | |

## Departures from the design

### D1 — Account and Cloudflare connection (2026-11-27)
The brief named account `openproduct-sms84q22` and the `nexo` Cloudflare
connection. The workspace was built in `openproduct-6ny98czp` (`ws_52SNF622`)
on its active Cloudflare connection, at the user's direction (risk PW-L).

### D2 — Baseline (2026-11-27)
Built from `cirrus-baseline` `baseline-v28`, the successor of the retired
`cirrus` (risk PW-K). The bootstrap's own PRs are #1 and #2.

### D3 — No product domain at bootstrap
`pagewell.app` is not registered, so the build was not given a domain; the
product answers on `*.vijayakrishnan12994.workers.dev` until a domain exists.

### D4 — The Pagewell brand lives in the bridge, not `crates/pagewell-brand` (PW-4)
The plan named a separate `crates/pagewell-brand`. The brand is two strings handed to
upstream patch P2's `HostBrand`, so it is `crates/pagewell-web-bridge/src/brand.rs`, and the
shell's wordmark and icon are in `apps/editor-web/public/`. A crate can be split out when a
second consumer (the console, PW2) needs the marks.

### D5 — The editor page is a plain module, not a React shell (PW-7)
The page around the editor is a header (open, save, undo, status) and a canvas; the editor
itself is egui. React would add a build step and bytes for no behaviour, so the shell is
`public/editor.{html,js,css}`. The drive and sharing UI live in the Next.js console (PW2+).

### D6 — The editor bundle is prebuilt and pinned (PW-7)
`apps/editor-web` does not compile Rust. The Rust lane publishes the bundle on the
`editor-artifacts` release, named by the hash of the Rust sources, and the app pins it by
sha256 (`editor-artifact.pin.json`), the same pattern as the baseline's console artifact.
The wasm ships as `.wasm.br` because Workers Static Assets refuse files over 25 MiB.

### D7 — The editor's wasm is built with a size profile, without wasm-opt (PW-8)
`profile.web` in `Cargo.toml`: opt-level z with fat LTO, except the PDF interpreter,
rasteriser, font, codec and image crates, which keep opt-level 3 (opt-level z everywhere
rendered pages 1.9x slower). `wasm-opt -Oz` was measured and rejected: it shrank the raw
module but grew the brotli one. The design's ≤ 8 MB budget is still missed (risk PW-C).

### D8 — Firefox in CI runs headed on software GL
GitHub's runners have no GPU and headless Firefox finds no GL driver, so the editor (WebGL2)
cannot start there. The e2e job runs Firefox headed under Xvfb on Mesa's llvmpipe. Users
whose browser has no WebGL2 now get a message saying so instead of a page stuck loading.
