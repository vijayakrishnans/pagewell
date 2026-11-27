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
