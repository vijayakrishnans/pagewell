import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { check, hitsIn, visibleText } from "./check.mjs";

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brand-"));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

test("a mark in user-visible text fails, wherever it is", () => {
  const root = tree({
    "apps/x/src/a.ts": 'export const label = "Open in PdfCraft";\n',
    "apps/x/public/p.html": "<h1>Pdf Craft</h1>",
    "crates/pagewell-y/src/lib.rs": 'pub fn f() -> &\'static str { "ArtCraft Studio" }\n',
    "apps/x/public/artcraft-logo.png": "",
    "apps/x/src/b.tsx": "export const B = () => <p>Made with ArtCraft</p>;\n",
  });
  assert.equal(check(root).length, 5);
});

test("descriptive sentences, comments, identifiers, imports, tests and vendor pass", () => {
  const root = tree({
    "crates/pagewell-y/src/lib.rs": [
      "//! PdfCraft's editor, mounted on a canvas.",
      "use pdfcraft_ui_egui::PdfCraftApp;",
      'const ABOUT: &str = "Pagewell is built on PdfCraft (MIT OR Apache-2.0). Not affiliated with ArtCraft or Adobe.";',
      "#[cfg(test)]",
      'mod tests { const X: &str = "PdfCraft"; }',
    ].join("\n"),
    "apps/x/src/a.ts": 'import { x } from "pdfcraft-thing";\n// PdfCraft comment\nexport const y = x;\n',
    "apps/x/scripts/build.mjs": 'const p = "vendor/pdfcraft";\n',
    "crates/other/src/lib.rs": 'const S: &str = "PdfCraft";\n',
    "vendor/pdfcraft/README.md": "# PdfCraft\n",
  });
  assert.deepEqual(check(root), []);
});

test("visible text drops comments and keeps literals", () => {
  assert.deepEqual(visibleText('// "PdfCraft"\nconst a = "hi";', "a.ts"), ["hi"]);
  assert.ok(hitsIn("PDFCRAFT"));
  assert.ok(!hitsIn("Pagewell is built on PdfCraft"));
});

test("the repository passes", () => {
  assert.deepEqual(check(path.resolve(import.meta.dirname, "../..")), []);
});
