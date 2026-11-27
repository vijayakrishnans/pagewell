# pagewell-pdf-workspace (PW) — Implementation status

As-built ≠ intent. This file records what actually shipped, and every place
the code departed from `design.md`.

| Milestone | State | PR |
|---|---|---|
| PW0 — the spec | ✅ done 2026-11-27 (PW-1 doc set; PW-2 public, listing-ready repo) | #3, PW-2 PR |
| PW1 — editor on the web | in progress (PW-3 vendor subtree) | |
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
