# Third-party notices

Pagewell is licensed under Apache-2.0 (see `LICENSE` and `NOTICE`). It
includes or builds on the third-party work below, each under its own licence.

## PdfCraft

Portions Copyright (c) the PdfCraft / ArtCraft contributors, used under Apache-2.0.

- Source: https://github.com/storytold/pdfcraft, release `v0.22.0`
  (`ac140f809d554981a5276d748e6193fcf4d4bdfa`), the pinned `PDFCRAFT_REF`.
- PdfCraft is offered under **MIT OR Apache-2.0**; Pagewell takes it under
  **Apache-2.0** for its patent grant. Both licence texts are kept unchanged
  in `vendor/pdfcraft/LICENSE-APACHE` and `vendor/pdfcraft/LICENSE-MIT`, and
  PdfCraft's own `NOTICE` in `vendor/pdfcraft/NOTICE`, from milestone PW1, when the
  source is vendored as a git subtree.
- **Not affiliated.** Pagewell is not affiliated with, endorsed by or sponsored by
  ArtCraft or Adobe. The ArtCraft name, wordmark and logos are trademarks of the
  ArtCraft Team, are not open source, and do not appear in Pagewell.

### What Pagewell derived and modified

| Area | Use in Pagewell | Modified? |
|---|---|---|
| PdfCraft engine and editor crates (`vendor/pdfcraft/crates/*`) | dependency of `crates/pagewell-*` | No. Any upstream patch is listed in `vendor/UPSTREAM-PATCHES.md` |
| `pdfcraft-ui-egui` | the editor canvas inside `apps/editor-web` | Rebranded at run time by `crates/pagewell-brand` (marks replaced); code unmodified |
| `apps/pdfcraft-web` host mode | the model for `crates/pagewell-web-bridge` | New crate; upstream file unmodified |
| `pdfcraft-cli` | the job runner inside `containers/pdf-runner` | Built unmodified at `PDFCRAFT_REF` |
| `pdfcraft-cli tools` output | `specs/epics/pagewell-pdf-workspace/pdf-tools.json` | Generated, unmodified |

## Bundled assets

PdfCraft's fonts, icons and images keep their own licences (including the SIL
Open Font License 1.1 fonts and the ISC/MIT Lucide icons). Its `ATTRIBUTION.md`
is carried forward unchanged at `vendor/pdfcraft/ATTRIBUTION.md`; the root
`ATTRIBUTION.md` extends it with Pagewell's own assets.

## Orunbase cirrus-baseline

The Workers fleet, console, packages and infrastructure were generated from the
Orunbase `cirrus-baseline` (`baseline-v28`) and are covered by this repository's
Apache-2.0 licence and `NOTICE`. npm and Cargo dependencies keep their own
licences, as declared in `pnpm-lock.yaml` and `Cargo.lock`.
