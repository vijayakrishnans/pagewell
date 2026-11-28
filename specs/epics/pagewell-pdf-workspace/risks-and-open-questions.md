# pagewell-pdf-workspace — risks and open questions

Each entry is a letter, a title, and a state: **RISK** (open, with a
mitigation), **RESOLVED** (decided; say what and why), **ACCEPTED** (a cost we
carry knowingly), **SETTLED** (decided for now; revisit on a stated cadence).

## PW-A — Engine maturity (RISK, mitigated)

PdfCraft calls itself alpha (about 57% of tracked features done) and fuzzing
still finds crashes and hangs. Mitigations: pin releases (`v0.22.0`), never
follow `main`; the editor runs in its own top-level page so a crash cannot
take the drive down; server-side PDF work runs only in the jailed container
with time and memory limits; the original upload is kept as version 1
forever; crashes are reported upstream with generated repros.

## PW-B — Embedding the web build (RISK, mitigated)

Upstream's web entry might not expose open-bytes, get-bytes or `Automation`
to JavaScript. Found at PW0: v0.22.0 ships a host mode (`craft-web-host`,
`data-host="page"`) with an open inbox, a host save function and a dirty
function, and an opt-in page command API (`window.pdfcraft`). Open and save
should need no patch. Also at PW0: `pdfcraft-automation` compiles for
`wasm32-unknown-unknown` (`cargo check --release`, warnings only). Still open:
binding the editor's open document to an `Automation` inside the bridge. PW1
measures this first; the fallback is a small upstream patch in
`vendor/UPSTREAM-PATCHES.md`, also opened on `storytold/pdfcraft`.

## PW-C — Wasm size and memory (RISK, open: both PW1 budgets are missed)

A large wasm plus large PDFs can exhaust mobile browsers. Budgets are gated
in PW1 (≤ 8 MB compressed first load; ≤ 2 s to first page of 100 pages).
Huge files open read-only with server-rendered pages if needed.

**Measured (PW-4, PW-7, PW-8; numbers in `ai/context/pagewell-ledger.md`):**
- First load: the editor wasm ships at **10,666,672 B brotli**, 2.67 MB over the
  8 MB budget, after the size profile took it down from 13,019,492 B. Tried and
  measured: name stripping (kept), opt-level z with fat LTO (kept, with the
  rendering crates at opt-level 3 so pages render within ~10% of release),
  `wasm-opt -Oz` (rejected: larger once compressed).
- First page: 7.5 s on stage for a first visit with the release bundle (13.16 MB;
  ~2.4 s of it download), ~2.3 s locally without network. Repeat visits use the
  immutable cache.

**The budgets are not raised.** What is left, in order of expected yield:
1. Split PdfCraft's automation tools (used only by the assistant, PW5+) into a
   second wasm module loaded on first use. Needs an upstream seam between the
   editor and `pdfcraft-automation`; to be measured before it is proposed.
2. Drop engine features the web editor does not use from the bridge build
   (feature flags upstream would have to offer).
3. Show page 1 before the editor is ready: a server- or worker-rendered first
   page (PW4's renderer) while the wasm downloads.
Owner: the editor's next milestone that touches the bridge; re-measured on every
bundle the Rust lane publishes (the `wasm build` step summary).

## PW-D — Comments as a projection (RISK, mitigated)

Injecting server comments into the PDF and syncing back can drift. The server
is the source of truth; round-trip integration tests; anchors that no longer
match are marked `outdated`, never silently moved.

## PW-E — Container limits and cost (RISK, mitigated)

Cloudflare Containers have cold starts and per-instance limits. PW4 measures
them and sizes per-plan job limits; container seconds are metered from day
one; load tests run against stage only.

## PW-F — D1 limits (ACCEPTED)

No interactive transactions and per-database size limits. Metadata only in
D1, content in R2; writes are idempotent batches with unique constraints and
retry.

## PW-G — AI safety and prompt injection (RISK, mitigated)

Document text can carry instructions into the agent loop. Tool calls that
share, delete, redact or send are always confirmed by the user in chat, or by
the org's MCP confirmation policy; retrieved text is passed as delimited
data; agents act with the calling user's permissions and cannot widen them.

## PW-H — E-signature expectations (ACCEPTED)

Customers may assume legal equivalence with Acrobat Sign. Pagewell offers a
simple electronic signature with an audit trail and states that on pricing
and help pages; no claims about qualified or advanced signatures.

## PW-I — Brand and trademarks (SETTLED)

The ArtCraft name and logos are not open source. No ArtCraft or PdfCraft
marks on user-visible surfaces; a CI check greps for them from PW1. "PdfCraft"
appears only in descriptive sentences, the notices and the vendored source;
"Acrobat" only in nominative comparison. Revisit at every `PDFCRAFT_REF` bump.

## PW-J — Accessibility of the canvas (ACCEPTED)

egui's canvas is weaker for screen readers than HTML. The HTML surfaces meet
WCAG 2.2 AA (axe in CI); the canvas gap is tracked here; PdfCraft's
Accessibility Checker stays available for documents; fixes go upstream.

## PW-K — Baseline name (RESOLVED)

The brief names the `cirrus` baseline. The registry retired `cirrus` at
`baseline-v13`; its blueprint refuses to instantiate and names the successor
`cirrus-baseline` (sourceplane/cirrus-baseline, `baseline-v28`, the same
worker fleet and conventions). Pagewell builds on `cirrus-baseline`.

## PW-L — Workspace account and Cloudflare connection (RESOLVED)

The brief named account `openproduct-sms84q22` and its `nexo` Cloudflare
connection. The signed-in login is not a member of that account root, so a
workspace could not be created there (404). On 2026-11-27 the user chose
account `openproduct-6ny98czp` instead: workspace `pagewell` is
`ws_52SNF622`. In that account `nexo` is revoked (and is never reconnected),
so the product deploys through the account's active Cloudflare connection
(`int_4da71819…`, workers.dev subdomain `vijayakrishnan12994`), and the repo
lives at `vijayakrishnans/pagewell`, the account's GitHub connection.

## PW-M — Build tooling on the build machine (RISK, open)

The machine the factory runs on had no Rust toolchain (installed at PW0:
rustc/cargo 1.100.0 with `wasm32-unknown-unknown`) and no Docker in its
WSL distro. The `pdf-runner` image (PW4) is built in CI; local runs of it
need Docker Desktop's WSL integration turned on.

## PW-N — The editor holds the console's session token (open, 2026-11-28)
Open in the console hands the editor tab the console's bearer token by postMessage (D11),
because the two are separate origins with no shared cookie domain. Exposure: a script running
on the editor origin could use it for the token's lifetime. Mitigations in place: the editor's
CSP is `default-src 'self'` with no third-party script; the token goes to the editor origin and
the opened window only, never into a URL; the editor keeps it in sessionStorage (that tab only).
Fix: a product domain with a shared `HttpOnly` cookie, or a short-lived, document-scoped editor
token from identity-worker. Decide by PW11 (prod).


## PW-O — Link-password guessing is limited per colo, not globally (open, 2026-11-28)
A share link with a password answers `401` until the right one is sent. api-edge rate-limits
`/v1/l/*` at 60 requests a minute per client address, but reads use the in-isolate limiter, so a
guesser spread across many colos and addresses gets more tries than that. Mitigations in place:
the token itself is 256 bits (the password is a second factor, not the only one); passwords are
8–200 characters; they are PBKDF2-SHA256 hashed (100,000 iterations, per-link salt); every open
is counted in `files_link_opens`. Fix if it matters: count failed password attempts per link in
D1 and lock the link for a while after N failures. Decide by PW11 (prod).
