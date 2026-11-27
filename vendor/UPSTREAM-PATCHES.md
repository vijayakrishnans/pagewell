# Upstream patches to vendor/pdfcraft

`vendor/pdfcraft/` is storytold/pdfcraft at **`PDFCRAFT_REF` = `v0.22.0`**
(`ac140f809d554981a5276d748e6193fcf4d4bdfa`), added as a squashed git subtree
(`git-subtree-dir: vendor/pdfcraft`, `git-subtree-split: ac140f80…`). It is
built from, never written to: product code lives in `crates/pagewell-*`.

A patch here is a last resort. Each one is the smallest possible change, has a
row below with its reason, and is opened as the same change on
storytold/pdfcraft. Bumping `PDFCRAFT_REF` is one task: `git subtree pull
--prefix vendor/pdfcraft https://github.com/storytold/pdfcraft.git <tag>
--squash`, re-apply the rows still open (drop the ones merged upstream),
regenerate `specs/epics/pagewell-pdf-workspace/pdf-tools.json`, rebuild the
container, and re-run the PW1 budgets and every end-to-end test.

Verify the patches are the only change (v0.22.0's tree is
`751f6c3d26c62010b1d724ec17d4de5c31e09b76`):

```bash
git diff --stat 8727aaa58 HEAD -- vendor/pdfcraft   # 8727aaa58 = the unmodified subtree (PW-3)
```

| # | Files | Reason | Upstream PR | State |
|---|---|---|---|---|
| P1 | `crates/automation/src/lib.rs` (+ a test in `tests/it/automation.rs`) | `Automation::open_bytes(name, bytes, password) -> doc`: open a document from bytes the caller holds. `doc_open` takes a path, and a browser page running the wasm build has no file system, so the editor's in-browser tool executor (PW9) had no way to give the tools its document. 7 lines; no behaviour change for existing callers | issue [storytold/pdfcraft#8536](https://github.com/storytold/pdfcraft/issues/8536), PR [#8537](https://github.com/storytold/pdfcraft/pull/8537) (ported onto upstream `main` c34c6c5; its test passes there) | open |
| P2 | `crates/ui-egui/src/brand.rs` (new) and one-line call sites in `app.rs`, `menus.rs`, `chrome.rs`, `home.rs`, `dialogs.rs`, `dialogs/palette.rs`, `hotbar.rs`, `lib.rs` | A host brand (`brand::set(HostBrand { name, about })`), set once by an embedding host: its name replaces "PdfCraft" in the window/page titles, the app menu and About; PdfCraft's community links (Discord, web page, GitHub, ArtCraft website) and the ArtCraft marks are left out of the menus, palette, tool bar, Home and About. The ArtCraft name and logos are trademarks that a product built on PdfCraft must not show. With no brand set nothing changes (unit tests) | issue [storytold/pdfcraft#8538](https://github.com/storytold/pdfcraft/issues/8538), no PR: upstream `main` has moved its UI onto the `craft::ui` framework, and a `ui-egui/src/brand.rs` there now draws the ArtCraft mark, so the patch doesn't apply. The issue asks the maintainers where the switch belongs and offers the PR | open |

Each patch is offered upstream from the fork `vijayakrishnans/pdfcraft`. When one merges
upstream, the next `PDFCRAFT_REF` bump drops it from this table.
