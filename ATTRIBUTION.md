# Attribution

Every asset Pagewell includes or bundles, with its author, source and licence.

## PdfCraft's assets

PdfCraft's `ATTRIBUTION.md` (and its machine-readable `ATTRIBUTION.toml`, with
the SHA-256 of every asset) is carried forward **unchanged** at
`vendor/pdfcraft/ATTRIBUTION.md` from milestone PW1. It lists every font, icon
and image PdfCraft ships, among them:

- the Inter, JetBrains Mono and Dancing Script typefaces (SIL Open Font License 1.1);
- Lucide icons (ISC AND MIT, Feather-derived);
- the fonts of the optional `craft-fonts` build input (SIL OFL 1.1), when a build uses it.

Those assets keep their own licences; the licence texts stay beside them in
`vendor/pdfcraft/`.

**Excluded on purpose:** the ArtCraft and PdfCraft names, wordmarks, logos and
app icons (`docs/brand/**`, `assets/app-icon/**` upstream) are trademarks, not
open source. Pagewell does not show them on any user-visible surface; the
`brand` CI check (`tooling/brand-check`) fails on any that appear.

## Pagewell's own assets

| Asset | Title | Author | Licence | Source | Used for |
|---|---|---|---|---|---|
| `apps/editor-web/public/favicon.svg`, the header icon in `editor.html` | Pagewell page mark | Pagewell contributors | Apache-2.0 | drawn for Pagewell | the editor's tab icon and header |
