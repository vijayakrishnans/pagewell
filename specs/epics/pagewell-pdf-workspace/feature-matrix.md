# pagewell-pdf-workspace — feature matrix

One row per capability. Every PR updates the rows it touches. Status is one
of `planned | in_progress | shipped | verified | deferred`; `deferred` needs a
reason; `⛔ Blocked` is added beside the status when a row waits on
`WAITING.md`. "Acrobat" is used nominatively, for comparison only.

| Capability | Acrobat has it | PdfCraft engine has it | Pagewell milestone | Status | Test id |
|---|---|---|---|---|---|
| Edit a PDF in the browser: open a local file, edit, save to disk, undo tool edits | Yes | Yes (desktop, web build) | PW1 | verified (Chromium, Firefox, WebKit) | `tests/editor-e2e` › a local file opens, is edited, undone and saved to disk |
| View, search, organize, merge, split | Yes | Yes | PW1 (engine) | shipped (the editor UI on stage; organize verified through tools, the rest not yet tested) | `tests/editor-e2e` (organize) |
| Forms fill and author | Yes | Yes | PW1 (engine) | shipped (in the editor UI; no Pagewell test yet) | |
| Encryption, redaction, sanitize | Yes | Yes | PW1 (engine); server-side apply PW4 | shipped in the editor UI (PW1); server-side apply built, not deployed (PW4) ⛔ Blocked (W4) | `containers/pdf-runner` › redact, sanitize (CI, in the image) |
| OCR | Yes | Latin script | PW4 (browser and container, Latin) | in_progress: container OCR verified in its image in CI, not deployed ⛔ Blocked (W4) | `containers/pdf-runner` › ocr |
| OCR, non-Latin scripts | Yes | No | upstream | deferred: engine limit, tracked upstream | |
| Edit existing text | Yes | Thin | upstream roadmap | deferred: not built here (design §5) | |
| Office ⇄ PDF | Yes | Missing | PW11 (LibreOffice container, flag-gated) | planned | |
| Accounts, cloud storage, versions | Yes | No | PW2 | verified (stage, 2026-11-28) | `tooling/e2e/drive-stage.mjs`; `tests/editor-e2e` › cloud-live, cloud; `tests/files-worker`; `tests/db` › files |
| Org sharing, links, guests | Yes | No | PW3 | verified (stage, 2026-11-28) | `tooling/e2e/sharing-stage.mjs`; `tests/editor-e2e` › cloud-live (link), cloud (links); `tests/policy-engine` › permission matrix; `tests/files-worker` › sharing; `tests/db` › files-sharing; `tests/web-console-next` › sharing |
| Comments synced across people | Yes | Local only | PW5 | verified on stage (Chromium, two browsers; comments on a page, not a selection) | `tests/review-worker`; `tests/editor-e2e` › review: comments show as text…; `cloud-live` › two people in one document |
| Review requests | Yes | No | PW5 | verified on stage through the API (emails and reminders in tests; asking from the console is later) | `tests/review-worker` › review requests; `tooling/e2e/review-stage.mjs` |
| Request e-signatures | Yes (Acrobat Sign) | No | PW6 (simple e-signature) | in_progress (API, both orders, completion through the runner; the signing page and builder next; completion on stage waits on W4) | `tests/db` › sign; `tests/sign-worker`; runner image tests |
| Heavy jobs off-device | Yes (cloud) | No | PW4 | in_progress: runner verified in CI; jobs API live on stage without a runner ⛔ Blocked (W4) | `containers/pdf-runner` (19 checks); `tests/pdf-jobs-worker`; `tooling/e2e/jobs-stage.mjs` |
| Remote MCP for agents | Partial | Local stdio MCP | PW7 | planned | |
| Chat with documents, citations | Yes (AI Assistant) | No | PW8 | planned | |
| Edit by chat | Yes | No | PW9 | planned | |
| Shared AI spaces | Yes (PDF Spaces) | No | PW10 (Spaces-lite) | planned | |
| Printing on the web | Yes | Missing | PW4 (server-rendered print PDF) | in_progress: Print in the editor built and tested against a faked API ⛔ Blocked (W4) | `tests/editor-e2e` › cloud (Print); `containers/pdf-runner` › print |
