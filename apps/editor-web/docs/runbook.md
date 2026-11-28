# editor-web runbook

**The page loads but the editor stays on "Loading the editor…".** Open the browser console. A
404 on `/pkg/<hash>/…` means `dist/` was built from a different pin than the page: rebuild.
A CSP error names the blocked source; the worker's `CSP` constant is the policy.

**The build fails with a sha256 mismatch.** The release asset changed under its name, which
should never happen (assets are content-addressed and published skip-if-present). Do not
re-pin to the new digest without finding out why.

**The build warns that the Rust sources hash differently.** The editor code changed after the
pinned bundle was built. Once the Rust lane on `main` publishes the new bundle, update
`editor-artifact.pin.json` from its step summary (url, sha256, sourceHash).

**Re-deploy stage.** Merge to `main`; orun's `deploy` profile for stage runs the build,
`wrangler deploy` and the smoke.

## Review panel
- **Save is greyed out**: someone else holds the edit lease (the banner names them), or you can only
  comment. It frees 60 s after their tab closes or loses its connection.
- **Comments don't arrive live**: the room's WebSocket isn't connecting. Check that the editor's
  CSP `connect-src` lists the API's `wss:` origin and that api-edge passes `…/room` through.
