# editor-web

Pagewell's PDF editor on the web. A small Worker (`src/worker.ts`) in front of Workers Static
Assets serves:

| Route | What |
|---|---|
| `/edit/local` | The editor; open a PDF from this device, edit it, save it back to disk |
| `/edit/<docId>` | The editor with a seeded document. Until the drive (PW2) only `fixture`, a generated 100-page PDF |
| `/pkg/<sourceHash>/…` | The editor bundle: `crates/pagewell-web-bridge` compiled to wasm. The wasm is stored brotli-compressed and served with `Content-Encoding: br` |
| `/health` | `{"ok":true}` |

## The editor bundle

Compiling the editor takes the better part of an hour, so deploys never do. The Rust lane
(`.github/workflows/rust.yml`) builds it on `main` (or on a dispatch) and publishes
`editor-<sourceHash>.tar.gz` on the `editor-artifacts` release, where `sourceHash` hashes the
committed Rust sources. `editor-artifact.pin.json` pins one asset by URL and sha256; the build
(`node scripts/editor-artifact.mjs build`) fetches it, verifies it and writes `dist/`. When the
Rust sources move on, the build warns until the pin is updated.

Static Assets take files up to 25 MiB. The raw wasm is larger, so it is shipped as `.wasm.br`
(about 13 MB) and the worker passes the compressed bytes through.

## The page API

`window.pagewell` exposes `editor` (`PagewellEditor`: `open`, `save`, `isDirty`, `automation`,
`undo`, `canUndo`) and the page's own `open`, `save` and `automation`, for tests.

## Review (PW5)

For a drive document the editor shows a side panel (`public/review.js`): the document's comment
threads, a form to comment on a page, replies, resolve and reopen, who else is here, and the edit
lease. It joins the document's room in review-worker over a WebSocket with a single-use ticket
(`POST …/room/ticket`), reconnecting when it drops. The first person who may edit holds the lease;
Save is off for the others until it is free. Comments are always rendered as text.

## Signing page (PW6)

`/s/<token>` is the signer's page (`public/signing.js`): no account, the link token is the key,
checked by sign-worker. The signer asks for an emailed code and enters it, then reads each
document exactly as sent (the editor, view only), fills their fields in the side panel (a typed
or drawn signature or initials, text, checkboxes; the date is set by the server), ticks the
consent box and signs, or declines with a reason. It works at phone width (the panel goes under
the document). Everything shown is rendered as text.
