# pagewell-pdf-workspace (PW) — Implementation status

As-built ≠ intent. This file records what actually shipped, and every place
the code departed from `design.md`.

| Milestone | State | PR |
|---|---|---|
| PW0 — the spec | ✅ done 2026-11-27 (PW-1 doc set; PW-2 public, listing-ready repo) | #3, #4 |
| PW1 — editor on the web | ✅ done 2026-11-28: vendor subtree (PW-3), upstream hooks P1/P2 (PW-5, PW-6), Rust workspace + bridge (PW-4), editor-web on stage (PW-7), three browsers, budgets, brand check (PW-8). Both budgets missed and recorded (risk PW-C) | #5, #6, #7, #8, #9, #10 |
| PW2 — drive | ✅ done 2026-11-28: data layer (PW-9), files worker (PW-10), R2 buckets (PW-11), api-edge facade (PW-12), the drive in the console (PW-13), the editor opens and saves drive documents (PW-14), files worker live on stage and prod (PW-15). Verified on stage: 44 API checks and the real editor (see "PW2 on stage") | #11–#18 |
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

