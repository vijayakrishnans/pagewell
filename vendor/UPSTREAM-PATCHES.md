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

Verify the tree is unmodified:

```bash
git rev-parse HEAD:vendor/pdfcraft          # must equal the tag's tree when this table is empty
# v0.22.0 tree: 751f6c3d26c62010b1d724ec17d4de5c31e09b76
```

| # | Files | Reason | Upstream PR | State |
|---|---|---|---|---|
| — | none | | | |
