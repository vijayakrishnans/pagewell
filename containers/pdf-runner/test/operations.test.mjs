// The operation table: every script names only the runner's own files, options are validated
// into plain values, and nothing a request sends can become a path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { OPERATIONS, OptionError, plan } from "../operations.mjs";

const PATHS = (steps) => JSON.stringify(steps).match(/"(path|out|out_dir)":"[^"]*"|"paths":\[[^\]]*\]/g) ?? [];

test("every operation has a plan, and every path in it is the runner's own", () => {
  const options = { split: { every: 1 }, extract: { pages: [1] }, rotate: { degrees: 90 } };
  for (const op of OPERATIONS) {
    const p = plan(op, options[op] ?? {}, op === "merge" ? 2 : 1, op === "merge" ? [3, 2] : [3]);
    for (const path of PATHS(p.steps)) assert.match(path, /"(in-\d+\.pdf|out\/[a-z0-9-]+\.(pdf|png)|out)"/, `${op}: ${path}`);
    assert.ok(p.outputs.length > 0, op);
  }
});

test("options are validated into numbers, booleans and enums", () => {
  assert.throws(() => plan("rotate", { degrees: 45 }, 1, [3]), OptionError);
  assert.throws(() => plan("rotate", { degrees: "90" }, 1, [3]), OptionError);
  assert.throws(() => plan("extract", { pages: [0] }, 1, [3]), OptionError);
  assert.throws(() => plan("extract", { pages: [4] }, 1, [3]), OptionError);
  assert.throws(() => plan("extract", { pages: ["../../etc/passwd"] }, 1, [3]), OptionError);
  assert.throws(() => plan("extract", {}, 1, [3]), OptionError);
  assert.throws(() => plan("split", { every: 1, before: [2] }, 1, [3]), OptionError);
  assert.throws(() => plan("compress", { preset: "../x" }, 1, [3]), OptionError);
  assert.throws(() => plan("render", { dpi: 2000 }, 1, [3]), OptionError);
  assert.throws(() => plan("render", { pages: Array.from({ length: 51 }, () => 1) }, 1, [100]), OptionError);
  assert.throws(() => plan("flatten", { fields: "yes" }, 1, [3]), OptionError);
  assert.throws(() => plan("nope", {}, 1, [3]), OptionError);
  assert.throws(() => plan("rotate", [], 1, [3]), OptionError);
});

test("unknown options are ignored, never passed through", () => {
  const p = plan("rotate", { degrees: 90, path: "/etc/passwd", out: "../x.pdf", tool: "doc_delete" }, 1, [3]);
  assert.doesNotMatch(JSON.stringify(p.steps), /passwd|\.\.\/x|doc_delete/);
});

test("merge takes 2 to 50 inputs; everything else exactly one", () => {
  assert.throws(() => plan("merge", {}, 1, [3]), OptionError);
  assert.throws(() => plan("merge", {}, 51, Array(51).fill(1)), OptionError);
  assert.throws(() => plan("rotate", { degrees: 90 }, 2, [3, 3]), OptionError);
  assert.deepEqual(plan("merge", {}, 3, [1, 1, 1]).steps[0].args.paths, ["in-0.pdf", "in-1.pdf", "in-2.pdf"]);
});

test("render writes one PNG per page asked, at the dpi asked", () => {
  const p = plan("render", { pages: [2, 3], dpi: 72 }, 1, [3]);
  assert.deepEqual(p.outputs.map((o) => o.name), ["page-2.png", "page-3.png"]);
  assert.equal(p.steps[1].args.dpi, 72);
});
