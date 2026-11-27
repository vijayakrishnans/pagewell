# pagewell-pdf-workspace — feature matrix

One row per capability. Every PR updates the rows it touches. Status is one
of `planned | in_progress | shipped | verified | deferred`; `deferred` needs a
reason; `⛔ Blocked` is added beside the status when a row waits on
`WAITING.md`. "Acrobat" is used nominatively, for comparison only.

| Capability | Acrobat has it | PdfCraft engine has it | Pagewell milestone | Status | Test id |
|---|---|---|---|---|---|
| View, search, organize, merge, split | Yes | Yes | PW1 (engine) | planned | |
| Forms fill and author | Yes | Yes | PW1 (engine) | planned | |
| Encryption, redaction, sanitize | Yes | Yes | PW1 (engine); server-side apply PW4 | planned | |
| OCR | Yes | Latin script | PW4 (browser and container, Latin) | planned | |
| OCR, non-Latin scripts | Yes | No | upstream | deferred: engine limit, tracked upstream | |
| Edit existing text | Yes | Thin | upstream roadmap | deferred: not built here (design §5) | |
| Office ⇄ PDF | Yes | Missing | PW11 (LibreOffice container, flag-gated) | planned | |
| Accounts, cloud storage, versions | Yes | No | PW2 | planned | |
| Org sharing, links, guests | Yes | No | PW3 | planned | |
| Comments synced across people | Yes | Local only | PW5 | planned | |
| Review requests | Yes | No | PW5 | planned | |
| Request e-signatures | Yes (Acrobat Sign) | No | PW6 (simple e-signature) | planned | |
| Heavy jobs off-device | Yes (cloud) | No | PW4 | planned | |
| Remote MCP for agents | Partial | Local stdio MCP | PW7 | planned | |
| Chat with documents, citations | Yes (AI Assistant) | No | PW8 | planned | |
| Edit by chat | Yes | No | PW9 | planned | |
| Shared AI spaces | Yes (PDF Spaces) | No | PW10 (Spaces-lite) | planned | |
| Printing on the web | Yes | Missing | PW4 (server-rendered print PDF) | planned | |
