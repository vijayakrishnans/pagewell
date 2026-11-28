# pagewell-pdf-workspace — gaps register

What is not built, or was built differently from `design.md`: why, what is missing, what was
done instead, and where it lands. Updated in every PR that opens, closes or changes a gap.
Departures are detailed in `IMPLEMENTATION-STATUS.md` (D-numbers); risks in
`risks-and-open-questions.md` (PW-letters).

Status: **open** (missing, planned), **partial** (some of it built), **differently** (built
another way, on purpose), **blocked** (waits on something outside the code), **closed**.

## Editor (PW1)

| Gap | Status | Why | What is missing | What was done instead | Lands |
|---|---|---|---|---|---|
| First-load budget (≤ 8 MB brotli) | open | The engine's wasm is large; size work hit diminishing returns | 2.67 MB over: 10.67 MB ships | Size profile, name stripping, opt-level z with render crates at 3; `wasm-opt` rejected (bigger compressed). Budget not raised (PW-C) | Split automation into a second module (PW5), or a server-rendered first page (PW4) |
| First page of 100 pages ≤ 2 s | open | Download dominates a first visit | 7.5 s first visit on stage, ~2.3 s without network | Immutable caching for repeat visits (PW-C) | As above |
| Canvas accessibility | differently | egui draws on a canvas; no DOM for assistive tech | WCAG on the canvas itself | Accepted risk PW-J; HTML surfaces around it are accessible | Upstream |
| Edit existing text, non-Latin OCR | differently | Engine limits (design §5) | The features | Deferred upstream in the feature matrix | Upstream |

## Drive (PW2)

| Gap | Status | Why | What is missing | What was done instead | Lands |
|---|---|---|---|---|---|
| Edit lease (`DocRoom`) | open | Not needed to prove versions; a Durable Object of its own | One editor at a time, read-only for the rest, admin break | Concurrent saves are caught by `baseVersion`: `409` → Save as copy / Reload (D11) | PW5 (presence, comments) |
| Thumbnails in the console's listing | open | An `<img>` cannot carry the bearer token | Thumbnails in the drive list | The editor stores a page-1 PNG per version; the API serves it | With a fetch-to-blob path or signed URLs |
| Editor session | differently | Console and editor are separate origins, no shared cookie domain (D3) | A narrow, short-lived editor token | The console's token is handed by `postMessage` to the editor origin only, kept per tab (D11, risk PW-N) | PW11 (product domain or editor token) |
| Quotas from metering | differently | Storage is a level, not a sum of events | Metering rollups as the source | Billing entitlements with a free tier; usage computed from `files_*` (D10) | Closed as built |
| API paths `/v1/orgs/{org}` | differently | The baseline's edge serves `/v1/organizations/{org}` | The design's shorter path | Same routes under the baseline path (D10) | Closed as built |

## Orgs and sharing (PW3)

| Gap | Status | Why | What is missing | What was done instead | Lands |
|---|---|---|---|---|---|
| Members' names and emails in the console | open | The baseline's members API returns user ids only; its Members page shows them raw | People shown by name; picking a member by name in the share dialog | Members offered by user id (as the baseline does); sharing by email always works, and a member's email grant applies to them (D16) | An identity profile lookup for members |
| "Groups" in the share dialog | open | No group model in the baseline | Sharing with a group | People one by one, and links | Later, if asked for |
| Guest email verification step | differently | A magic-link sign-in already proves the address | A separate guest code | A guest grant matches whoever signs in with that email; first sign-in recorded as verified (D13) | Closed as built |
| Link-token pepper | differently | A 256-bit random token cannot be guessed from its hash | A pepper secret | Plain SHA-256 of the token; PBKDF2 for passwords (D13) | Closed as built |
| "Allow download" off | partial | The browser must receive the bytes to render them | Preventing a determined copy | The viewer hides Download; the API marks it (D13) | Closed as built (documented) |
| Link-password guessing limit | closed | — | — | Per-link lockout: 10 wrong passwords lock a link for 15 minutes (PW-26), on top of the edge's per-address limit | Done in PW-26 |
| Commenter role | partial | Comments arrive in PW5 | Commenting | The role is stored, decided by policy (`files.comment`) and shown; links may carry it | PW5 |
| Invitations to members | differently | Members already see shares in Shared with me | An email to a member | Emails go to guests only (`files.shared`) (D14) | Closed as built |
| Emails actually delivered on stage | blocked | Stage runs `DEBUG_DELIVERY`: codes and messages are returned, not mailed | Seeing a real inbox receive the invite | The enqueue is tested; the template is tested | When an email provider is set for stage/prod (PW11) |
| Team profile | closed | The bootstrap shipped the single-user profile | — | `SOLO_MODE` off everywhere; members and invitations live (D15) | Done in PW-18 |

## Heavy jobs (PW4)

| Gap | Status | Why | What is missing | What was done instead | Lands |
|---|---|---|---|---|---|
| The runner in Cloudflare Containers | blocked (W4) | Deploying a Container needs the Containers permission; no token template grants it | Jobs running on stage and prod | The image is built and tested in CI, with no network | When the platform declares a template with Containers and the secret exists |
| Runner reads R2 through the wrapper | differently | The Worker can stream inputs and outputs; the container then needs no network at all | — | Inputs in the request body, outputs in the response (D17) | Closed as built |
| Cloudflare Queue for jobs | differently | The deploy token cannot create Queues (W4) | A Queue | One Durable Object per job runs it from an alarm and retries (PW-24) | Closed as built, unless Queues become available |

## Review (PW5)

| Gap | Status | Why | What is missing | What was done instead | Lands |
|---|---|---|---|---|---|
| Sync comments from the PDF (`annotationChanged`) | differently | The editor's bridge emits no annotation event | Comments made with the editor's own tools flowing to the server | The server is the source of truth; the editor's panel writes there (D20) | PW-30 |
| Mentions of anyone with access | partial | Telling a stranger a document's name would leak it | Mentioning people not yet in the conversation | Only earlier commenters and reviewers are emailed (D21) | Later, with member names (needs the members gap) |
| Comments anchored to a selection or a point | partial | The editor's bridge reports no selection or click position | Pinning a comment to a rectangle chosen on the page, and showing pins on the page | A comment names its page and, optionally, the words it is about (D22) | When the bridge reports a selection |
| Server comments drawn in the PDF view (injected, stripped on save) | not done | Needs annotation calls in the bridge, and a strip step before every save | Comments drawn on the page | The side panel lists them by page (D22) | Later |
| The drive checks the edit lease on save | not done | A second guard was judged unneeded: the version check already refuses a stale save | A save without the lease refused by files-worker | Save is off in the editor without the lease; the version check (409) still protects (D22) | Revisit if abuse shows up |
| Asking for a review from the console or editor | not done | The API came first | A "Request review" dialog | `client.review.requestReview` in the SDK and the API (D21) | PW6 or later |
| Room route `/v1/rooms/{doc}` | differently | The edge's org-scoped routing | — | `/v1/organizations/{org}/documents/{doc}/room` with a ticket (D21) | Closed as built |

## Security (OWASP review, PW-26)

| Gap | Status | Why | What is missing | What was done instead | Lands |
|---|---|---|---|---|---|
| Console framework advisories | closed | — | — | Next 15.5.29, React 19.2.9, @opennextjs/cloudflare 1.20.19 (PW-27); no critical advisory left | Done in PW-27 |
| zod 3 advisory (oversized collections) | open | Fixed only in zod 4, a breaking migration across contracts and forms | zod ≥ 4.6.6 | Inputs that reach zod are size-bounded by the edge and workers | A zod 4 migration task |
| postcss advisory (via Next) | differently | It is Next's build-time CSS tooling | — | Not in the deployed Worker | When Next updates it |
| Console CSP allows inline scripts | partial | Next's runtime inlines its bootstrap | Nonce-based script CSP | Self-only scripts, no eval, no plugins, no framing | Later, with a nonce middleware |

## Outside the code

| Gap | Status | Why | What is missing | What was done instead | Lands |
|---|---|---|---|---|---|
| Docker on the build machine | closed (W2) | — | Local runs of the `pdf-runner` image | CI builds images | User turns on Docker Desktop's WSL integration; needed for PW4 |
| Product domain | open | None at bootstrap (D3) | A domain with a shared cookie | workers.dev origins per environment | PW11 |
| Cloudflare Containers (and Queues) grant | blocked (W4) | No declared token template has the Containers or Queues permission | Deploying pdf-runner | Runner built and tested in CI; Durable Objects instead of a Queue | The platform adds a template; the user creates the secret |
| `orun/compliance` check | blocked | Never reports on this repo | The provenance check on PRs | Branch, trailer, manifest and `orun task check` kept by hand on every PR | User side |
