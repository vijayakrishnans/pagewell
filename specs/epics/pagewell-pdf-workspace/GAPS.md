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
| Link-password guessing limit | partial | Reads use the edge's in-isolate limiter | A global per-link lockout | 60/min per address per colo; 8+ character PBKDF2 passwords; opens counted (risk PW-O) | PW11 (per-link failure count) |
| Commenter role | partial | Comments arrive in PW5 | Commenting | The role is stored, decided by policy (`files.comment`) and shown; links may carry it | PW5 |
| Invitations to members | differently | Members already see shares in Shared with me | An email to a member | Emails go to guests only (`files.shared`) (D14) | Closed as built |
| Emails actually delivered on stage | blocked | Stage runs `DEBUG_DELIVERY`: codes and messages are returned, not mailed | Seeing a real inbox receive the invite | The enqueue is tested; the template is tested | When an email provider is set for stage/prod (PW11) |
| Team profile | closed | The bootstrap shipped the single-user profile | — | `SOLO_MODE` off everywhere; members and invitations live (D15) | Done in PW-18 |

## Outside the code

| Gap | Status | Why | What is missing | What was done instead | Lands |
|---|---|---|---|---|---|
| Docker on the build machine | blocked (W2) | WSL integration is off | Local runs of the `pdf-runner` image | CI builds images | User turns on Docker Desktop's WSL integration; needed for PW4 |
| Product domain | open | None at bootstrap (D3) | A domain with a shared cookie | workers.dev origins per environment | PW11 |
| `orun/compliance` check | blocked | Never reports on this repo | The provenance check on PRs | Branch, trailer, manifest and `orun task check` kept by hand on every PR | User side |
