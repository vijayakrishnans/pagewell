import assert from "node:assert/strict";
import test from "node:test";

import { fixturePdf } from "./fixture.mjs";

test("the fixture is a PDF with the pages asked for and a valid xref", () => {
  const pdf = fixturePdf(100).toString("latin1");
  assert.ok(pdf.startsWith("%PDF-1.7"));
  assert.ok(pdf.trimEnd().endsWith("%%EOF"));
  assert.match(pdf, /\/Count 100 /);
  assert.equal(pdf.match(/\/Type \/Page /g).length, 100);

  const startxref = Number(pdf.match(/startxref\n(\d+)/)[1]);
  assert.ok(pdf.slice(startxref).startsWith("xref\n"));
  const entries = pdf.slice(startxref).split("\n").slice(3).filter((l) => / 00000 n $/.test(l));
  for (const [i, line] of entries.entries()) {
    const at = Number(line.slice(0, 10));
    assert.ok(pdf.slice(at).startsWith(`${i + 1} 0 obj`), `xref entry ${i + 1} points at its object`);
  }
});

test("the fixture says it is generated", () => {
  assert.match(fixturePdf(1).toString("latin1"), /Nothing here is a real document/);
});
