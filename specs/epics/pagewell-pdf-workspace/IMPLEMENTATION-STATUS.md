# pagewell-pdf-workspace (PW) — Implementation status

As-built ≠ intent. This file records what actually shipped, and every place
the code departed from `design.md`.

| Milestone | State | PR |
|---|---|---|
| PW0 — the spec | ✅ done 2026-11-27 (PW-1 doc set; PW-2 public, listing-ready repo) | #3, #4 |
| PW1 — editor on the web | ✅ done 2026-11-28: vendor subtree (PW-3), upstream hooks P1/P2 (PW-5, PW-6), Rust workspace + bridge (PW-4), editor-web on stage (PW-7), three browsers, budgets, brand check (PW-8). Both budgets missed and recorded (risk PW-C) | #5, #6, #7, #8, #9, #10 |
| PW2 — drive | ✅ done 2026-11-28: data layer (PW-9), files worker (PW-10), R2 buckets (PW-11), api-edge facade (PW-12), the drive in the console (PW-13), the editor opens and saves drive documents (PW-14), files worker live on stage and prod (PW-15). Verified on stage: 44 API checks and the real editor (see "PW2 on stage") | #11–#18 |
| PW3 — orgs and sharing | ✅ done 2026-11-28: sharing data and the access rules with the permission matrix (PW-16), files-worker enforces sharing with links, guests, activity and audit (PW-17), team profile on (PW-18), sharing at the edge, in the SDK and by email (PW-19), sharing in the console (PW-20), the share-link viewer and the stage run (PW-21). Verified on stage: 47 sharing checks and the real editor on a link (see "PW3 on stage") | #19–#25 |
| PW4 — heavy jobs | in progress: the runner image (PW-23, #27), pdf-jobs-worker, its data, the edge and the SDK (PW-24, #28, live on stage without a runner), tools in the console and Print in the editor (PW-25). Running jobs waits on the Containers grant (WAITING W4) | #28 |
| PW5 — review | ✅ done 2026-11-28: review data and the anchor rule (PW-28), review-worker with the DocRoom (PW-29), the editor's panel, presence and lease (PW-30). Verified on stage: 30 review checks over real WebSockets and the two-browser editor test (see "PW5 on stage") | #33–#37 |
| PW6 — e-sign | in progress: e-sign data and the evidence chain (PW-31), the runner's `sign_complete` (PW-32), sign-worker with the signing API (PW-33), the signing page and the console's envelopes (PW-34) | #38–#41 |
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

### D9 — Drive migration is `200_files_core`; version bytes get a fresh key per write (PW-9, PW-10)
- **Migration number.** The plan names `100_files_core`, but the baseline already uses 100
  (`100_metering_foundation`) and runs to 190. The drive's migration is `200_files_core`, in a
  new `files` bounded context; Pagewell's later migrations follow from 200.
- **R2 key for a version.** The design's `org/<orgId>/doc/<docId>/v/<version>.pdf` would let two
  writers racing on the same `baseVersion` write the same key before the database decides which
  one wins, so the loser could overwrite the winner's bytes. A version's bytes are stored at
  `org/<orgId>/doc/<docId>/blob/<blobId>.pdf`, a fresh id per write: a racing write never
  clobbers another, and a restore points the new version at the old object (storage counts it
  once). PW-9 keyed blobs by sha256; PW-10 changed that, because the key is needed before the
  body has streamed through the digest. The sha256 is still recorded on the version row. The
  helper in `packages/shared/src/r2-keys.ts` is the only place keys are built.

### D10 — Drive routes, quotas and uploads as built (PW-10)
- **Paths.** The drive lives under the baseline's `/v1/organizations/{org}/…`, not the design's
  `/v1/orgs/{org}/…`, so `api-edge` fronts it like every other worker. The folder listing is
  `GET /folders` (root) and `GET /folders/{fld}`, with a breadcrumb.
- **Quotas** come from the org's billing entitlements (`files.storage_bytes`,
  `files.max_file_bytes`, `files.versions_per_document`, quantity, null = unlimited), not
  from metering's usage rollups: storage is a level, not a sum of events. Usage is computed
  from the `files_*` tables. A plan that sets none, or billing being unreachable, gets the free
  tier (2 GiB, 100 MiB per file, 100 versions), never unlimited. Billing's internal-caller
  allowlist gains `files-worker`.
- **Rights.** `policy-engine` gains `files.read` (every org role but billing_admin),
  `files.write` and `files.delete` (owner, admin, builder). Folder and document grants come
  with sharing in PW3.
- **Uploads.** One request carries up to 95 MiB, streamed into R2 while it is hashed. Larger
  files use R2 multipart (10 MiB parts, 24 h to finish), and the completed object is checked
  against the sha256 the client sends.
- **The bucket (PW-11, PW-15).** `infra/terraform/cloudflare-r2` creates `pagewell-files-<env>`
  with the brokered `r2-data` token (W3), scoped to exactly those two names, so the bucket
  name drops the runner's `stg-`/`prod-` prefix that the other roots use. `files-worker`
  binds it from the `WIRING_CLOUDFLARE_R2` secret and deploys on push to `main`.
- **The edge (PW-12).** `api-edge` forwards the drive routes to `FILES_WORKER` with the actor
  headers, streaming bodies both ways; the drive has its own rate-limit family (300 per
  identity, 1,500 per org per minute: a multipart upload is a request per part). CORS admits
  the editor's workers.dev origin of the same environment, so the editor can open and save
  documents directly. Until files-worker deploys, the binding points at the fleet's
  placeholder Worker and the drive routes answer 503.

### D11 — The drive lives in the console; Open hands the editor a session by postMessage (PW-13)
- **Where.** The design's drive route `/o/:org/drive/:folder?` is `/orgs/:orgSlug/drive[/:folderId]` in
  the baseline console (plus `/drive/trash`), first in the sidebar in both profiles. It lists
  folders and documents with a breadcrumb, uploads by button or drop (multipart above 95 MiB,
  with progress), creates and renames folders, moves to trash, shows version history with
  download and restore, and shows storage used. Thumbnails in the listing come later: an
  `<img>` cannot carry the bearer token, so they need a fetch-to-blob path or signed URLs.
- **The editor's session.** The editor is its own origin (`apps/editor-web`) and cannot read the
  console's storage, and there is no shared cookie domain yet (D3). Open opens the editor in a
  new tab; when that tab posts `pagewell:hello`, the console answers that window only, at the
  editor's origin only, with the bearer token and the API base (`lib/drive.ts` `handoffReply`).
  The token never appears in a URL. It is the console's session token, not a narrower one:
  risk PW-N. A product domain with a shared cookie, or a short-lived editor token minted by
  identity-worker, replaces this.
- **The editor's side (PW-14).** `/edit/<doc_…>?org=<org_…>` asks the opener for the session as
  soon as the page loads, accepts it only from the console's origin and the opener window, for
  this org and this API, and keeps it in sessionStorage. The worker derives the paired API and
  console origins from its own host (`pagewell-editor-web-<env>` → `pagewell-api-edge-<env>`,
  `pagewell-web-console-next-<env>`), writes them into the page, and allows that API alone in
  `connect-src`. A stale save opens a dialog: save as a copy (it opens), reload, or keep
  editing. Each save sends a 36 dpi page-1 PNG and `text_extract`'s text, best-effort. The
  edit lease (`DocRoom`) is not built yet: concurrent editors are caught by `baseVersion` alone.

### D12 — The R2 bucket names drop the runner's prefix (PW-11)
The other Terraform roots name resources `${namespacePrefix}…` (`stg-`, `prod-`). The bucket is
`pagewell-files-<env>` with no prefix, because the brokered `CLOUDFLARE_R2_TOKEN` (`r2-data`,
created by the user, W3) is scoped to exactly those two names; the first plan named
`stg-pagewell-files-stage`, which the token could not have created.

### D13 — Sharing as built: one decision in policy, guests by verified email, plain token hashes (PW-16)
- **One decision.** `policy-engine` decides a folder or document action (`files.read`,
  `files.comment`, `files.write`, `files.delete`, `files.share`) from three facts files-worker
  gathers and sends in `context.attributes.files`: the principal (member, guest or link), the
  roles of the grants that reach the resource for that person, and the link's role. The org role
  is the floor (owner, admin, builder → editor; viewer → viewer; billing_admin → nothing); the
  widest of floor, grants and link wins. A link is read or comment only, whatever is stored;
  only members share. `tests/policy-engine` › permission matrix runs org role × grant set ×
  action (6 × 6 × 5) and link role × action against a table written from the design.
- **Inheritance at read time.** A folder grant is not copied down: `grantsReaching` walks the
  resource's folder chain in SQL, so a move changes inherited access with no rewrite.
- **Guests are people who sign in.** The design's guest "email verification" is the magic-link
  sign-in itself: a guest grant is matched to whoever signs in with that email (identity has
  proved it), and the first such sign-in is recorded (`verified_at`, `user_id`). There is no
  separate guest session or code.
- **Link tokens.** 32 random bytes, stored as plain SHA-256, without the design's pepper secret:
  a 256-bit token cannot be guessed from its hash, so the pepper would only add a secret to
  manage. Passwords are PBKDF2-SHA256 with a per-link salt.
- **`allow_download` is a viewer setting, not a control.** The bytes must reach the browser to be
  rendered; turning download off hides the button and nothing more.

### D14 — files-worker's sharing as built (PW-17)
- **Each route names what it needs.** Org-wide (`GET /folders`, recent, trash, quota, guests):
  members only, decided as before. On a folder or document: the grants that reach it for the
  caller (member id, or their verified email for guest grants) go to `policy-worker`'s
  effective-permissions with the org role; one call per resource per request, cached. An
  owner, admin or builder skips the grant read (no grant can widen an editor floor). Create,
  upload and move also check the destination folder (or the root, members only).
- **Uploads continue only for whoever started them**, and only while they may still write
  where the upload goes.
- **A guest's breadcrumb** starts at the highest folder shared with them; folders above it are
  never named.
- **Links** answer the linked document, or the linked folder's listing (`?folderId=` for a
  folder inside it, checked against the subtree), and `/content?documentId=`. Responses to a
  link holder blank the owner's user id. Opens are counted with day-salted hashes of the
  address and user agent; one `link.opened` audit entry per open of the link, not per folder
  browsed inside it.
- **Audit event ids are UUIDv7 with a counter inside the millisecond**, so two events written
  in one request (a guest invited, then granted) keep their order in the activity list, which
  is ordered by time and then id.
- **Invite emails (PW-19).** Sharing with a guest queues `files.shared` through
  notifications-worker (files-worker is an allowed internal caller): what was shared, the role,
  the sharer's message, and a button to the console's Shared with me. Once per share or role
  change; never for members (they find it in Shared with me); `notify: false` skips it.
- **At the edge (PW-19).** api-edge forwards the signed-in person's email (`x-actor-email`) to
  files-worker, routes `/guests`, the sharing sub-routes and `/v1/me/shared`, and serves
  `/v1/l/{token}[/content]` with no session in its own rate-limit family (`links`: 60 a minute
  per client address), forwarding only the link password and client hints. CORS allows the
  password header and exposes `x-pagewell-allow-download`. Reads use the edge's in-isolate
  limiter, so a determined guesser spread across colos gets more than 60 tries a minute at a
  link password: passwords are 8+ characters and PBKDF2-hashed (risk PW-O).

### D15 — The team profile is on (PW-18)
The bootstrap shipped the baseline's M0/Solo profile (`SOLO_MODE=true` in api-edge,
identity-worker, membership-worker and the console build): one invisible personal org per
user, no members, no invitations, a second org refused (`403 solo_profile`). Pagewell is
multi-org by the brief, so PW3 turns the team profile on everywhere. What changes:
- **Orgs have members, roles and invitations** (the baseline's console pages under Settings).
- **No org is created at sign-in any more**; a new user makes their first org at onboarding
  (always allowed). A second org follows the baseline's billing gate (`feature.multi_org`).
  Users who signed in under Solo keep the personal org they got then.
- **An org's home is its Drive** in both profiles (`orgHomePath`), and Pagewell's nav is Drive
  and Settings: the baseline's Projects and Usage are platform plumbing, still reachable by
  URL, not in the nav.

### D16 — Sharing in the console as built (PW-20)
- **Share dialog** (row menu → Share…, folders and documents): add people by email (a guest,
  unless the address is a member's) or by a member's user id from a list, with a role, an
  optional message and "email them"; people with access, the resource's own grants first (role
  change, remove) then inherited ones ("From <folder>", changed on that folder); links with
  role, expiry (never, 1, 7, 30 days), optional password and allow download. A new link's URL
  (the editor's `/l/<token>`) is shown once, to copy; existing links can only be turned off.
- **Gap: members have no names or emails in the console.** The baseline's members API returns
  user ids only, and its Members page shows them raw; the share dialog offers members the same
  way. Sharing by email always works (a member's email grant applies to them too).
- **Shared with me** (`/shared`, in the sidebar): items from any org, documents open in the
  editor, folders browse at `/shared/<org>/<folder>` with the path from the shared folder down.
  A person with no org of their own is not sent to onboarding on these pages, and after sign-in
  lands on Shared with me when something is shared with them.
- **Activity** (row menu, documents): the audit entries for the document, newest first, paged.
- **Guests** (Settings → Guests): list, with whether each has opened anything, and remove.

### D17 — The PDF runner as built (PW-23)
- **One route, no network.** `containers/pdf-runner` is `pdfcraft-cli` (built from
  `vendor/pdfcraft`, without its MCP server), the two OCR models named in PdfCraft's
  `ATTRIBUTION.toml` (downloaded and checked by SHA-256 at build), Tesseract (English) and qpdf,
  behind a small Node wrapper. `POST /run` takes the inputs **in the request body** and returns
  the outputs **in the response**, so the container needs no network at all, not even R2 (the
  design had it reach R2 through the wrapper); the Worker in front reads and writes R2.
- **Nothing from a request becomes a path.** Twelve fixed operations (OCR, compress, merge, split,
  extract, rotate, flatten, redact, sanitize, render, text, print), each a literal
  `pdfcraft-cli run --script` over files the wrapper names itself (`in-N.pdf`, `out/…`); options
  are validated into numbers, booleans and enums. The CLI also runs with `--root <jobdir>`.
- **Limits.** Pages are counted in a first pass and checked before the operation runs; CPU seconds
  and address space are capped with `prlimit`, wall time with a kill; each job gets a fresh
  directory, removed afterwards. Hard ceilings in the image; a request may ask for less.
- **Tested in its image in CI** (`.github/workflows/pdf-runner.yml`): run with no network, a
  read-only root, 3 GB and 256 processes; 19 checks, every PDF output through `qpdf --check` and
  a page count, a script naming paths outside `--root` refused with nothing written, and the
  page, memory and wall-clock limits each stopping a job. Also green locally against the same CLI
  and models (2026-11-28).
- **Not deployed (WAITING W4).** A Cloudflare Container needs the Containers permission, which no
  declared token template grants.
### D18 — Jobs act through the drive; a Durable Object instead of a Queue (PW-24)
- **A job acts as the person who asked.** `apps/pdf-jobs-worker` keeps the job rows (migration
  `220_jobs_core`, with the actor's public id and verified email) and does every read and write
  through `files-worker` with that person's actor headers. The drive's rights, quotas, version
  conflicts and audit therefore apply to a job exactly as to the person: no second copy of the
  access rules. Creating a job checks read on the inputs and write where the result goes; a
  share removed before the job runs makes it fail with nothing written.
- **Results.** OCR, compress, rotate, flatten, redact and sanitize save the next version on the
  version the job read (a save in between: `version_conflict`, nothing written), or a new document
  beside it; merge, split and extract make new documents; render, text and print keep files for a
  day under `org/<orgId>/jobs/<jobId>/out/`.
- **A Durable Object per job, not a Queue.** The deploy token cannot create Queues (W4); a
  `JobRunner` Durable Object (SQLite-backed) runs the job from an alarm and retries an unreachable
  runner three times, backing off. The hourly sweep fails jobs running over 20 minutes and removes
  expired result files.
- **Limits** from billing entitlements (`jobs.pages_per_job`, `jobs.concurrent`,
  `jobs.cpu_seconds_per_job`; free tier 200 pages, 2 at a time, 120 CPU seconds), passed to the
  runner; a plan's unlimited is capped at the runner's ceilings.
- **Deploys without a runner.** `PDF_RUNNER` (the Container) is unbound until W4, so `POST /jobs`
  answers `503 runner_unavailable`; the rest of the API is live. api-edge routes `/jobs` (own
  rate-limit family) with the actor and email; the SDK has `client.jobs`.
- **Not yet:** progress through `DocRoom` (polling instead), metering container seconds.

### D19 — Tools and Print as built (PW-25)
- **Console:** row menu → Run a tool… (documents): the twelve operations with what each asks
  (pages as `1, 3-5`, degrees, every N pages, quality, documents to merge with from the same
  folder) and, for the versioning ones, next version or new document. Started jobs sit in a tray
  on the drive page, polled every 2 s until they end (toast, listing refreshed); a finished file
  result (print, text, page images) opens in a new tab through an authenticated fetch.
- **Editor:** Print (drive documents only) starts a `print` job on the version open in the editor,
  polls it, and opens the print-ready PDF in a tab opened by the click. Local files keep the
  browser's own print.
- **Without a runner** both say so ("Heavy tools aren't available here yet", "Printing from the
  server isn't available yet") instead of failing silently.

### D20 — Review data and anchors as built (PW-28)
- **Tables** (migration `240_review_core`, context `review`): `review_threads` (anchor JSON,
  version, open/resolved/outdated), `review_comments` (author, body, mentions; a deleted comment
  is blanked and keeps its place), `review_requests` and `review_request_reviewers` (by email; a
  request closes when every reviewer decided).
- **The server is the source of truth.** The editor's bridge emits no annotation-changed event,
  so the editor will not sync from the PDF: it shows server comments and sends new ones to the
  server (PW-30). This replaces the design's `annotationChanged` sync.
- **Anchors** (`packages/shared/src/anchors.ts`): a thread is carried to a newer version when its
  page still exists and its quote is still on that page (or, with no quote, the page's text is
  unchanged), else marked `outdated`, never moved to another page. It compares the text the editor
  stores with every save; without stored text, a thread is kept while its page exists. Carrying is
  conditional on the version it was at, so two readers carry it once.

### D21 — review-worker and the DocRoom as built (PW-29)
- **Acts through the drive**, like jobs: read to see, comment to write and resolve, write to remove
  another's comment, share to ask for a review or break a lease. The DocRoom is a class in
  review-worker, as designed; routes are org-scoped (`/v1/organizations/{org}/documents/{doc}/room`)
  rather than the design's `/v1/rooms/{doc}`.
- **Joining the room takes a ticket.** A browser cannot send an Authorization header on a WebSocket,
  so the editor asks `POST …/room/ticket` (with access) for a single-use ticket that lives 60
  seconds and opens the socket with it; the session token never goes in a URL. api-edge passes the
  upgrade straight through (a 101 is not re-wrapped) with only the WebSocket headers.
- **The lease** belongs to one connection, lasts 60 s unless renewed, ends on leave or by its
  alarm, and can be broken by anyone who may share the document (the design's "admin").
  New-version notices come from the lease holder's own save, not from files-worker.
- **Review requests share the document with each reviewer** as a commenter through the drive's
  share (guests invited as usual), email `review.requested`, close when everyone decided; a daily
  cron sends `review.reminder` to those who have not, near and after the due date.
- **Mentions email only people already in the conversation** (earlier commenters on the document,
  reviewers of an open request), so a mention cannot reveal a document's name to a stranger.
- **Threads and comments get time-ordered ids** (UUIDv7): two written in one millisecond keep
  their order. The frozen-clock tests caught it.
- **files-worker** gains `GET …/versions/{n}/text` (read) for carrying anchors.
- **On stage (2026-11-28), `tooling/e2e/review-stage.mjs`, 23 checks green** over real WebSockets
  through api-edge: ticketed joins (a used ticket refused, a stranger gets none), presence, the
  lease held by the owner and refused to a guest commenter, comments and replies live both ways,
  the new-version notice, a quoted thread carried to v2 and one on a changed page outdated, the
  reviewer's decision closing the request, the lease freed on leave, and the audit log.

### D22 — review in the editor as built (PW-30)
- **A side panel** in the editor for drive documents: the document's threads (as the server
  carried them), a comment on a page with the words it is about, replies, resolve and reopen.
  Every comment is rendered as text (`textContent`), never as HTML; the mocked test puts markup in
  a comment and checks it is shown, not run.
- **Comments are on a page, not a selection**: the editor's bridge does not report a selection or
  a click position yet, so the anchor is the page (`rect [0,0,0,0]`) plus the quoted words. The
  design's injection of server comments into the PDF view (with a marker stripped before save) is
  not built; the panel is the view.
- **The room from the browser**: a ticket per (re)connect, then a WebSocket to
  `wss://<api>/v1/organizations/{org}/documents/{doc}/room` (the editor's CSP allows the API's
  `wss:` origin). It reconnects with backoff and refreshes the threads on reconnect; a 404 on the
  ticket stops it.
- **The lease is a courtesy, not the guard.** The first person who may edit takes it and renews it
  every 20 s; Save is off for everyone else (a banner names the holder; "Take over" for those who
  may share). When the room cannot be reached, Save stays on and the drive's version check (409,
  save as a copy or reload) still stops one save overwriting another. The drive does not check the
  lease itself.
- **The room says hello** with who you are and what you may do, so the panel can leave you out of
  "Also here", and each lease event says whether it is this connection's (`mine`), so one person
  in two tabs edits in one.

### PW5 on stage (2026-11-28)
Every done-when of PW5, on the deployed stage:
- **Comments live in both browsers**: `tests/editor-e2e` › `cloud-live` › "two people in one
  document" (Chromium, two browser contexts, the real editor): the owner holds the lease, the
  second person (shared as an editor) has Save off and sees who is editing; a comment and a reply
  arrive live each way; the owner's save offers the other a reload; when the owner leaves, the
  other's editor takes the lease and Save comes back. The other two live editor tests still pass.
- **Lease handover and break**: the handover above, and `tooling/e2e/review-stage.mjs` (30 checks):
  an editor holds the lease, the owner (who may share) breaks it, the editor is told, the owner
  takes it; a commenter cannot take it; the lease is freed on leave.
- **Anchors on a changed page**: the same run saves version 2 with changed text: the quoted thread
  is carried to v2, the one on a page whose text changed is outdated and stays on its page.

### D23 — e-sign data as built (PW-31)
- **Migration `250_sign_core`** (context `sign`): `sign_envelopes`, `sign_envelope_documents`
  (version, SHA-256 and page count frozen at send), `sign_signers`, `sign_fields`, `sign_events`.
  Names follow the repo's `<context>_<table>` convention rather than the design's `sign.` schema.
- **Links and email codes are stored only as SHA-256 hashes.** A link lives 14 days (a resend or
  reminder issues a new one and kills the old), is spent when its signer signs or declines, and
  every link of an envelope dies when it is declined, voided or expires. An email code lives 10
  minutes and five wrong tries spend it.
- **Signing rules in the repository**: only a verified signer whose turn it is (sequential: the
  lowest routing order not yet signed), only their own fields, every required one; the field writes
  and the signer update are one atomic batch, conditional on the signer still being able to sign.
  One decline ends the envelope.
- **The evidence log is append-only twice over**: triggers refuse `UPDATE` and `DELETE` on
  `sign_events`, and each event's hash covers the previous one
  (`@saas/shared/evidence`: SHA-256 over prev hash, seq, kind, time and the canonical JSON payload),
  so `verifyChain` finds a changed payload, a broken link or a gap. Two writers of the same place
  are refused by the primary key (the second retries).
- **The migration splitter** (`D1ApiAdapter.splitStatements`, also what deploys use) now keeps a
  `CREATE TRIGGER … BEGIN … END` body whole; it split at every `;` before, which no earlier
  migration needed.

### D24 — completion in the runner as built (PW-32)
- **`sign_complete` is a runner operation**, as the design puts completion in the heavy-jobs
  path: the envelope's documents combined in order, each value placed with the engine's Fill &
  Sign (typed text and dates in Helvetica, typed signatures and initials in the script font, drawn
  ones from PNG/JPEG images sent with the job, checks), everything flattened into page content, a
  certificate page appended, then one invisible certification signature (no changes allowed)
  with the platform's digital ID: **PAdES B-B, SHA-256** (`ETSI.CAdES.detached`). The script
  reopens the signed file and lists its signature; the runner refuses to answer unless there is
  exactly one, covering the whole file, unchanged since.
- **The certificate page** names the envelope, title, completion time, each document with its
  version, page count and the SHA-256 of the bytes as sent, each signer with email, time and IP,
  the evidence log's head hash before completion, and the statement that this is a simple
  electronic signature. The **hash after** (of the signed file) cannot be on the file it hashes; it
  goes into the evidence log and the completion email instead (PW-33).
- **The digital ID never comes from a request**: the container reads `SIGN_P12_B64` and
  `SIGN_P12_PASSWORD` (Worker secrets, passed to the container), writes `sign.p12` into the job's
  directory for that job only, and masks the password in any error. No ID: `503
  signing_unavailable`. Text reaching the page is reduced to what the standard fonts draw.
- **Validated two ways, locally and in CI**: pdfcraft-cli's `sign_list` (one signature, not
  modified, certified) and poppler's `pdfsig` ("Signature is Valid", "Total document signed");
  one changed byte reads "Digest Mismatch" in pdfsig and `invalid` in pdfcraft. The CI job makes a
  throwaway self-signed test ID; the production ID is made when the runner is deployed (W4).

### D25 — sign-worker as built (PW-33)
- **Sender's API** under `/v1/organizations/{org}/envelopes` (the design's `/v1/orgs/…`, in the
  repo's own spelling): drafts, send, resend, void, evidence. Managing an envelope needs `share`
  on every document in it, asked of the drive as the person; seeing one: that, or being its
  sender. A list shows the caller's own envelopes.
- **Signer's API** under `/v1/s/{token}` with no account. Verification is an emailed six-digit
  code (the design's "email one-time code"); a signer sees only their own fields and the other
  signers' names and status, and opens a document only after verifying, always at its frozen
  version. The date field is set by the server to the day of signing. Explicit consent
  (`consent: true`) is required and recorded.
- **Completion goes through pdf-jobs-worker's internal route** (`POST /internal/sign-complete`, a
  service binding only; api-edge never forwards it) to the runner's `sign_complete`, so sign-worker
  never holds the digital ID. Hashes of the frozen versions are checked again before sealing. The
  sealed PDF is uploaded to the sender's drive as a new document, and a 30-day view-and-download
  share link goes to everyone with the sealed file's SHA-256 (the "hash after", D24).
- **Waiting is honest**: without a runner the envelope stays `completing`; the hourly run
  (`27 * * * *`) retries after five minutes, expires envelopes, and sends reminders with fresh links.
- **The sender's email** is kept on the envelope (`251_sign_sender`) for "from" and for the decline
  notice; signers' and sender's emails are six new templates (`sign.requested`, `.reminder`,
  `.code`, `.declined`, `.voided`, `.completed`).
- **Stage returns links and codes** in responses (`DEBUG_DELIVERY`, as login codes there); prod never.
- **On stage (2026-11-28), `tooling/e2e/sign-stage.mjs`, 39 checks green**: parallel and sequential
  envelopes signed through to `completing` by two signers with no account (codes inline on stage),
  the frozen hash, own-fields-only, documents only after verifying, spent links, the evidence chain
  verifying with every step, decline and void killing links, a stranger's 404s, and the audit log.
  Completion itself waits on the runner (W4).
- **Verified with the real runner locally**: a two-signer envelope (one drawn signature) went
  through the real `sign_complete`; the PDF in the sender's drive validates in poppler's pdfsig
  ("Signature is Valid", "Total document signed") with its certificate page.

### D26 — the signing page and the console's envelopes as built (PW-34)
- **The signing page is the editor's `/s/<token>`** (the design's `sign.<domain>/s/:token`, on the
  editor's origin for now): the document opens in the editor view-only, the signer's steps live
  in the side panel: email code, their fields (typed in a script face or drawn on a pad; drawn
  ones are sent as PNG), consent, sign or decline. At 390 px the panel sits under the document.
- **Request signatures… on a document in the drive**: signers (name, email), parallel or in the
  order listed, reminders every 3 days, and for each signer a page and a spot (bottom left,
  bottom right, middle left, top right) with an optional date under the signature. Spots are
  rectangles on a Letter page: **fields are not placed by drawing on the page yet** (the console
  does not render pages; the editor's bridge reports no click position). One document per
  request from the console; the API takes up to ten.
- **Envelopes** (new nav entry): the sender's envelopes with status, per-signer progress and
  times, the evidence chain's verdict, Resend, Void, and Open the signed PDF once completed.

## OWASP review of PW2–PW4 (PW-26, 2026-11-28)
Asked for by the user for every build from now on; each PR states the areas it touches.
- **A01 Broken access control.** Every drive, sharing and jobs route decides from org role and
  grants through policy; another org's id, or no access, is the same 404. Covered by the route
  permission matrix, isolation tests in every worker, and the stage runs. Jobs act as the person
  through files-worker, so they cannot widen access. No change needed.
- **A02 Cryptographic failures.** Link tokens 256-bit random, stored as SHA-256; link passwords
  PBKDF2-SHA256 (100,000 iterations, per-link salt), compared in constant time. No change needed.
- **A03 Injection.** All SQL is parameterised; email templates escape names and messages and allow
  only plain https links; the editor's folder picker builds DOM with textContent; file names in
  Content-Disposition are percent-encoded; the runner turns no request value into a path or a tool.
- **A04 Insecure design / A07 Authentication.** Link-password guessing was limited per colo only
  (risk PW-O). **Fixed:** 10 wrong passwords in a row lock a link for 15 minutes, whoever guesses
  (migration `230_files_link_lockout`, `link.locked` audited). Open: the editor holds the console's
  token (risk PW-N, decide by PW11).
- **A05 Security misconfiguration.** **Found:** the console sent no security headers; API
  responses had no CSP or nosniff. **Fixed:** every api-edge response gets
  `default-src 'none'; frame-ancestors 'none'; sandbox`, nosniff, DENY framing, HSTS and
  no-referrer; every console route gets a CSP (self-only scripts, no plugins, no framing), DENY
  framing, nosniff, HSTS, a permissions policy and `same-origin-allow-popups` (keeps the editor
  handoff). Thumbnails must now be real PNG or WebP by their magic bytes.
- **A06 Vulnerable components.** **Found:** the console's Next.js 15.0.3 has critical advisories
  (RCE in the React flight protocol, middleware authorization bypass) and @opennextjs/cloudflare
  1.0.4 high ones (SSRF). **Fixed in PW-27:** Next 15.5.29, React 19.2.9, @opennextjs/cloudflare
  1.20.19 (its own @opennextjs/aws 4.2.1; the direct 3.6.2 pin is gone), wrangler 4.150. `pnpm
  audit --prod` went from 86 advisories (6 critical, 32 high) to 5 (no critical; high: postcss
  inside Next's build-time CSS tooling, which does not run in the Worker, and zod 3's
  oversized-collection DoS, which needs a zod 4 migration, recorded in GAPS).
- **A08 Integrity.** pdf-runner's base images are now pinned by digest; the OCR models were already
  checked by SHA-256; the editor bundle is content-addressed and pinned.
- **A09 Logging.** Every drive change and share event is audited (including link opens and locks);
  logs never carry document text, names or keys.
- **A10 SSRF.** The runner has no network; the jobs worker reaches only bound services (and a
  configured RUNNER_URL); no user-supplied URL is fetched anywhere.

## PW3 on stage (2026-11-28)
- **API, `tooling/e2e/sharing-stage.mjs`, 47 checks green** (twice: before and after the viewer
  deployed). An owner, an org viewer joined by invitation, a guest outside the org, and a second
  org's owner, with a generated PDF:
  - team profile: nothing is made at sign-in; an invitation is sent and accepted;
  - the viewer reads but cannot write by role; an editor grant on a folder lets them edit inside
    it and nowhere else;
  - a guest shared with by email opens what is in the folder and nothing else, cannot edit, see
    the root or share; Shared with me and their access are right; they are verified on first open;
  - the access list shows both grants as inherited from the folder;
  - a password link: `401` without or with a wrong password, opens with it (owner blanked),
    content `no-store` with download off, read only; revoked, **the very next request is `404`**;
  - isolation: the guest's grant means nothing in org B; org B's owner gets `404` on five org-A
    routes; removing the guest cuts their access at once;
  - the document's activity and the org's audit log (`category=files`) hold every share event,
    and never the link token.
- **Editor, `specs/cloud-live.spec.mjs`, green in Chromium against stage:** the PW2 drive run
  (now making its own org under the team profile), and a real link: the viewer asks for the
  password, opens the document view only with Download offered, and after the link is turned off
  a reload says it no longer works.
- **The PW2 drive run** (`drive-stage.mjs`, 44 checks) is green again under the team profile.

## PW2 on stage (2026-11-28)
- **API, `tooling/e2e/drive-stage.mjs`, 44 checks green.** Two throwaway users in their
  provisioned orgs, a generated PDF:
  - upload into a folder → v1, bytes round-trip;
  - save on base 1 → v2; a second save on base 1 → `409 version_conflict` (current 2);
  - thumbnail and text stored and served;
  - restore v1 → v3 with v1's bytes, v2 still readable;
  - a 10 MiB + 4 KiB multipart upload completes intact;
  - a 101 MiB file → `402 quota_exceeded (file_size)`; a non-PDF → `415`;
  - ten cross-org probes (org A's routes as the other user, org A's ids under org B) → `404`, and
    the document is unchanged; no session → `401`;
  - trash a folder: its document is marked trashed and its content is not served; restore brings
    it back; the quota counts the bytes; CORS admits the editor origin.
- **Editor, `tests/editor-e2e/specs/cloud-live.spec.mjs`, green in Chromium.** Nothing faked but
  the console page that hands over the session, on the console's real origin:
  - the real editor opens the uploaded document at v1;
  - a page delete and Save → v2 on the drive with 4 pages, and a thumbnail;
  - another writer saves v3, the editor's next save shows the conflict dialog, and Reload opens v3;
  - restore v1 → v4 with v1's bytes.
- **Sign-in on stage.** The magic-link code comes back inline there (`DEBUG_DELIVERY=true`; prod
  sends email). New users get one organization at sign-in, and a second is refused without a
  plan (403), so the checks use the provisioned org.

