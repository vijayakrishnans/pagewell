# pagewell-pdf-workspace — implementation plan

Milestones land in order, one in flight at a time. Each is one or more tasks
(`PW-k`), each task one pull request on an `orun/PW-<k>-<slug>` branch with
an `Orun-Task: PW-<k>` trailer on every commit and the manifest block in its
body, landed only when every check, `orun/compliance` included, is green. A
large milestone is split into several tasks under the same Orunbase milestone,
never into new milestones. A milestone is marked ✅ here by the PR that lands
its last task, which also records it in `IMPLEMENTATION-STATUS.md` and
updates the rows it touched in `feature-matrix.md`.

Local gates before every push:

```bash
pnpm install && pnpm typecheck && pnpm lint && pnpm test && pnpm build
cargo fmt --check && cargo clippy --workspace -- -D warnings && cargo test --workspace
pnpm editor:build          # wasm build + size budget check (from PW1)
pnpm test:e2e -- --changed # Playwright against local wrangler dev (from PW1)
orun task check --base main
orun validate --intent intent.yaml
orun plan --changed --intent intent.yaml --output plan.json
```

## PW0 — the spec ✅

This doc set (task PW-1), then the public, listing-ready repository (task
PW-2): Apache-2.0 `LICENSE`, `THIRD_PARTY_NOTICES.md`, `ATTRIBUTION.md`
(carried from PdfCraft and extended), `SECURITY.md`, `CONTRIBUTING.md`, a
README stating "built on PdfCraft (MIT/Apache-2.0); not affiliated with
ArtCraft or Adobe", topics `openproduct`, `pdf`, `mcp`, `webassembly`, secret
scanning, push protection and branch protection on `main`.

Touches: `specs/epics/pagewell-pdf-workspace/**`, `tasks/**`, repo root docs.

**Done when**
- the doc set, `pdf-tools.json` and `feature-matrix.md` are on `main`, with `PDFCRAFT_REF` recorded (v0.22.0, `ac140f80`)
- `task_get PW-1` and `task_get PW-2` read `done`
- `gh repo view --json visibility` reads `PUBLIC`; notices and brand rules are in place

## PW1 — editor on the web ✅

PdfCraft at `PDFCRAFT_REF` as a git subtree in `vendor/pdfcraft/`; a root
Cargo workspace whose members are `crates/pagewell-*` and which depends on the
vendored crates by path; `crates/pagewell-web-bridge` (wasm entry over
upstream's host mode: `open`, `save`, `isDirty`, `automation`, events);
`crates/pagewell-brand` (the Pagewell marks the bridge installs in place of
upstream's); `apps/editor-web` (Workers Static Assets, `/edit/local` and
`/edit/:docId` opening a seeded fixture, React shell); a wasm build in CI
with a size budget check; a CI check that fails on any ArtCraft or PdfCraft
mark on a user-visible surface. Cirrus components touched: `intent.yaml`,
CI workflow, `packages/contracts` (bridge types).

**Done when**
- a local file opens, is edited and saves to disk in Chromium, Firefox and Safari (Playwright through the bridge API, plus screenshot smoke)
- first-load size and first-page time are measured against the budgets (≤ 8 MB compressed; ≤ 2 s first page for the 100-page fixture) and recorded in the ledger; a miss is a risk entry with numbers
- the brand check passes: no ArtCraft marks remain on user-visible surfaces
- `/edit/local` answers on stage

## PW2 — drive

`apps/files-worker` (folders, documents, versions, uploads, trash), R2
bucket per env, multipart uploads, `baseVersion` conflicts, open from and
save to the cloud, thumbnails and text sent by the browser with a save,
30-day trash, quotas from Cirrus metering, drive UI in
`apps/web-console-next`. Migration `200_files_core` in `packages/db` (D9); wire
types in `packages/contracts`; facades in `api-edge`.

**Done when**
- end to end on stage: upload → open → edit → save → version 2 → restore version 1
- the conflict path (`409 version_conflict` → Save as copy / Reload) is tested
- storage, file-size and version quotas are enforced
- cross-org isolation tests cover every new table, route and R2 prefix

## PW3 — orgs and sharing

Grants with folder inheritance, share links (expiry, password, download),
guests with email verification, Shared with me, the Activity tab, audit
events, the share dialog. `policy-worker` gains the `files` resource kind.

**Done when**
- the permission matrix test (org role × grant × link × action) passes
- revoking a link takes effect on the next request
- the audit log shows every share event

## PW4 — heavy jobs

`containers/pdf-runner` built in CI from `vendor/pdfcraft` at the pinned ref
(`pdfcraft-cli` + Tesseract), a Queue, `apps/pdf-jobs-worker`, operations
OCR, compress, merge, split, extract, rotate, flatten, redact apply, sanitize,
render, text extraction, print PDF; job progress in the editor shell.

**Done when**
- each operation passes on generated fixtures, with output checked by `qpdf --check` and page counts
- a test that tries to escape the job's `--root` fails to
- per-job CPU, memory and page quotas are enforced
- print opens a server-rendered PDF in a new tab

## PW5 — review

Server comment threads with anchors (`apps/review-worker`), injection into
the editor through `automation` (`comment_add`) and sync back from
`annotationChanged`, the `DocRoom` Durable Object (presence, edit lease,
live fan-out, new-version notice), mentions with email, review requests with
reminders from a Cron Trigger, anchors carried forward or marked outdated
across versions.

**Done when**
- a two-browser test shows comments appear live in both
- lease handover and admin lease break work
- anchors on a fixture with a changed page are carried forward or marked `outdated` correctly

## PW6 — e-sign

`apps/sign-worker`, envelopes, field placement in the editor, the public
signing page, email codes, sequential and parallel order, reminders,
completion with a certificate page and a PAdES-B-B platform signature, the
hash-chained evidence log.

**Done when**
- two signers complete an envelope in both orders, end to end on stage
- the completed PDF's signature validates with `pdfcraft-cli` and poppler tools
- the evidence chain verifies, and a tampered PDF is detected

## PW7 — remote MCP

`apps/mcp-worker` (Streamable HTTP), OAuth 2.1 with Cirrus identity, API
keys, compact tool surface (drive tools + PDF tools on the container
executor), confirmations, metering, audit, the MCP settings page and docs.

**Done when**
- MCP Inspector conformance passes
- Claude connects with OAuth on stage and completes "find the invoice from Acme, extract pages 2–3, share with Rahul as viewer" on generated fixtures
- isolation tests pass per tool; every call is in the audit log

## PW8 — chat with documents

Indexing pipeline (text → page chunks → Vectorize), Ask with page citations
and jump-to-highlight, scopes, Workers AI via AI Gateway, BYOK, retention,
usage quotas (`apps/ai-worker`).

**Done when**
- the golden eval set (generated fixtures) scores ≥ 90% citation correctness
- a test proves a user can never retrieve chunks from a document they cannot read
- usage is metered per org

## PW9 — edit by chat

The agent loop with the browser executor in the editor and the container
executor elsewhere, tool cards with undo, confirm cards, agent provenance on
versions.

**Done when**
- scripted scenarios (reorder, rotate, fill a form, add comments, redact a term with confirmation, request a signature with confirmation) pass in the editor and via MCP
- every agent-made version shows its provenance

## PW10 — Spaces-lite

A shared collection of documents with a custom assistant prompt, a summary,
view tracking and link sharing.

**Done when**
- a space made from 3 documents is shared by link; a guest asks a question and gets cited answers only from those documents
- the owner sees the guest's view

## PW11 — prod, docs, launch

Prod hardening, a load test on stage, help docs, pricing, the OpenProduct
listing; optional Office → PDF through a LibreOffice container behind a flag
(deferred with a reason if quality is not met).

**Done when**
- the prod smoke test passes
- every `feature-matrix.md` row is `verified` or `deferred` with a reason
- the README status reads `✅ Shipped`

## Sequencing note

PW1 goes first and gates everything: it proves PdfCraft embeds on the web
within budget. If it finds the web build cannot be embedded without large
upstream changes, PW2+ stops and the finding (with evidence) goes to
`risks-and-open-questions.md` and `WAITING.md` with the smallest upstream PR
set. PW2 (versions, R2) is needed by everything after it. PW3's grants are
needed by PW5–PW10's permission checks. PW4's container is the executor for
PW6's completion step, PW7's PDF tools and PW9's out-of-editor edits. PW8's
index is needed by PW9 and PW10. Container, Durable Object, Vectorize and AI
work each first checks that the `nexo` token has the scope and the account
is on Workers Paid; a missing one goes to `WAITING.md` and work that does not
need it continues.
