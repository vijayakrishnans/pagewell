# Security policy

Pagewell stores other people's documents, so we take reports seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private vulnerability
reporting: **Security → Report a vulnerability** on this repository. Include
what you found, how to reproduce it, and the impact you expect. Do not include
real documents; generated PDFs are enough.

We aim to acknowledge a report within 3 working days and to agree on a fix and
disclosure date with you. We credit reporters who want credit.

## What is in scope

- Cross-org access of any kind: documents, versions, comments, envelopes,
  jobs, search results, vector search, MCP tools or audit records from an org
  you do not belong to.
- Share links, guest access and signing links that grant more than they should,
  or keep working after expiry or revocation.
- Escaping the `pdf-runner` job directory (`--root` jail) or reaching the network
  from a job.
- Prompt injection that makes the agent or MCP server share, delete, redact or
  send without the user's confirmation.
- Tampering with a completed signature envelope or its evidence chain without
  detection.
- Leaks of document text, prompts or completions in logs.

PDF parsing bugs in the PdfCraft engine itself (crashes, hangs) are welcome
here too; we forward them upstream to storytold/pdfcraft with a generated
reproduction.

## Supported versions

Only the current `main` (deployed to stage and prod) is supported.
