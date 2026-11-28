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
| Encryption, redaction, sanitize | Yes | Yes | PW1 (engine); server-side apply PW4 | shipped in the editor UI (PW1); server-side apply planned (PW4) | |
| OCR | Yes | Latin script | PW4 (browser and container, Latin) | planned | |
| OCR, non-Latin scripts | Yes | No | upstream | deferred: engine limit, tracked upstream | |
| Edit existing text | Yes | Thin | upstream roadmap | deferred: not built here (design §5) | |
| Office ⇄ PDF | Yes | Missing | PW11 (LibreOffice container, flag-gated) | planned | |
| Accounts, cloud storage, versions | Yes | No | PW2 | verified (stage, 2026-11-28) | `tooling/e2e/drive-stage.mjs`; `tests/editor-e2e` › cloud-live, cloud; `tests/files-worker`; `tests/db` › files |
| Org sharing, links, guests | Yes | No | PW3 | in_progress (rules and data: PW-16; API: PW-17; edge, SDK, invitations: PW-19) | `tests/policy-engine` › permission matrix; `tests/db` › files-sharing; `tests/files-worker` › sharing |
| Comments synced across people | Yes | Local only | PW5 | planned | |
| Review requests | Yes | No | PW5 | planned | |
| Request e-signatures | Yes (Acrobat Sign) | No | PW6 (simple e-signature) | planned | |
| Heavy jobs off-device | Yes (cloud) | No | PW4 | planned | |
| Remote MCP for agents | Partial | Local stdio MCP | PW7 | planned | |
| Chat with documents, citations | Yes (AI Assistant) | No | PW8 | planned | |
| Edit by chat | Yes | No | PW9 | planned | |
| Shared AI spaces | Yes (PDF Spaces) | No | PW10 (Spaces-lite) | planned | |
| Printing on the web | Yes | Missing | PW4 (server-rendered print PDF) | planned | |
