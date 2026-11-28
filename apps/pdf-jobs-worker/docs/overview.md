# pdf-jobs-worker

Pagewell's heavy jobs (milestone PW4): OCR, compress, merge, split, extract pages, rotate,
flatten, redact (apply), sanitize, render pages, extract text and print-ready PDF, run by
PdfCraft's `pdfcraft-cli` in the `pdf-runner` container (`containers/pdf-runner`) on stored
versions.

- **Acts as the person who asked.** Every read and write a job makes goes to `files-worker` with
  that person's actor headers (and verified email), so the drive's rights, quotas, version
  conflicts and audit apply exactly as in the console: inputs must be readable, a new version
  needs write on the document, new documents need write where they go.
- **Where results go.** OCR, compress, rotate, flatten, redact and sanitize save the next version
  of the document (on the version the job read: a save in between makes the job fail with
  `version_conflict`), or a new document beside it. Merge, split and extract make new documents.
  Render, text and print keep their files for a day (`org/<orgId>/jobs/<jobId>/out/…`).
- **Running.** `POST /jobs` writes the row and hands it to a `JobRunner` Durable Object (one per
  job), which runs it from an alarm and retries a runner it could not reach (3 tries). A
  Durable Object stands in for the design's Queue: the workspace's deploy token cannot create
  Queues or Containers (WAITING W4); it can deploy Durable Objects.
- **Limits** per job from billing entitlements (`jobs.pages_per_job`, `jobs.concurrent`,
  `jobs.cpu_seconds_per_job`), free tier 200 pages, 2 at a time, 120 CPU seconds; the runner
  enforces pages before it starts and CPU, memory and wall time while it runs.
- **Not yet live.** Until the Containers grant exists, `PDF_RUNNER` is unbound and `POST /jobs`
  answers `503 runner_unavailable`; everything else deploys.

## Routes (under `/v1/organizations/{org}`)

| Method | Path | Who |
|---|---|---|
| POST | `/jobs` | read on the inputs; write where the result goes |
| GET | `/jobs?documentId=` | read on the document (without it: the caller's own jobs) |
| GET | `/jobs/{job}` | its creator, or a reader of its document |
| POST | `/jobs/{job}/cancel` | its creator, while queued |
| GET | `/jobs/{job}/files/{name}` | as `GET /jobs/{job}`, for a day |

## E-sign completion (PW6)

The runner's `sign_complete` operation seals an e-sign envelope: documents combined, values placed
and flattened, a certificate page, and a PAdES B-B certification signature with the platform's
digital ID, which only the container holds (`SIGN_P12_B64`, `SIGN_P12_PASSWORD`). sign-worker asks
for it when the last signer signs; it is not a job people start themselves.
