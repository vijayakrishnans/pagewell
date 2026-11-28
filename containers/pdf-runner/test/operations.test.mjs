// The operation table: every script names only the runner's own files, options are validated
// into plain values, and nothing a request sends can become a path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { OPERATIONS, OptionError, plan, winAnsi } from "../operations.mjs";
import { completionOptions } from "./fixtures.mjs";

const PATHS = (steps) => JSON.stringify(steps).match(/"(path|out|out_dir)":"[^"]*"|"paths":\[[^\]]*\]/g) ?? [];

test("every operation has a plan, and every path in it is the runner's own", () => {
  const options = { split: { every: 1 }, extract: { pages: [1] }, rotate: { degrees: 90 }, sign_complete: completionOptions() };
  for (const op of OPERATIONS) {
    const multi = op === "merge" || op === "sign_complete";
    const p = plan(op, options[op] ?? {}, multi ? 2 : 1, multi ? [2, 1] : [3], { images: 1, imageNames: ["sig-0.png"], signPassword: "test-only" });
    for (const path of PATHS(p.steps)) assert.match(path, /"(in-\d+\.pdf|out\/[a-z0-9-]+\.(pdf|png)|out|combined\.pdf|sig-\d+\.(png|jpg))"/, `${op}: ${path}`);
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

test("sign_complete: values land on the right page of the combined file; the ID and the certificate are the runner's", () => {
  const extra = { images: 1, imageNames: ["sig-0.png"], signPassword: "test-only" };
  const p = plan("sign_complete", completionOptions(), 2, [2, 1], extra);
  const fills = p.steps.filter((s) => s.tool === "fill_sign_add");
  assert.deepEqual(fills.map((s) => [s.args.page, s.args.type]), [[1, "signature"], [1, "text"], [2, "check"], [2, "text"], [3, "signature"], [3, "initials"]]);
  assert.equal(fills[4].args.path, "sig-0.png");
  assert.deepEqual(fills[0].args.at, [72, 620]);
  const sign = p.steps.find((s) => s.tool === "sign_document");
  assert.deepEqual([sign.args.id, sign.args.certify, sign.args.out], ["sign.p12", "no_changes", "out/result.pdf"]);
  assert.equal(p.steps.find((s) => s.tool === "page_insert_blank").args.at, 4);
  const certText = p.steps.filter((s) => s.tool === "page_add_text").map((s) => s.args.text).join("\n");
  for (const want of ["a".repeat(64), "Ann Example <ann@example.com>", "203.0.113.7", "c".repeat(64), "no claim to be an advanced or qualified"]) assert.ok(certText.includes(want), want);
  assert.deepEqual(p.outputs.map((o) => o.name), ["result.pdf", "signature.json"]);
});

test("sign_complete refuses what it cannot place, and needs the runner's ID", () => {
  const extra = { images: 0, imageNames: [], signPassword: "test-only" };
  const bad = (mut) => {
    const o = completionOptions();
    mut(o);
    o.fields = o.fields.filter((f) => f.image === undefined || mut.keepImage);
    return o;
  };
  assert.throws(() => plan("sign_complete", bad((o) => (o.fields[0].page = 3)), 2, [2, 1], extra), OptionError);
  assert.throws(() => plan("sign_complete", bad((o) => (o.fields[0].doc = 2)), 2, [2, 1], extra), OptionError);
  assert.throws(() => plan("sign_complete", bad((o) => (o.fields[0].kind = "stamp")), 2, [2, 1], extra), OptionError);
  assert.throws(() => plan("sign_complete", bad((o) => (o.fields[0].rect = [0, 0, 0, 10])), 2, [2, 1], extra), OptionError);
  assert.throws(() => plan("sign_complete", bad((o) => (o.certificate.documents[0].sha256 = "../../etc")), 2, [2, 1], extra), OptionError);
  assert.throws(() => plan("sign_complete", bad((o) => o.certificate.documents.pop()), 2, [2, 1], extra), OptionError);
  assert.throws(() => plan("sign_complete", completionOptions(), 2, [2, 1], extra), OptionError); // the image field, but no image sent
  assert.throws(() => plan("sign_complete", bad(() => {}), 2, [2, 1], { images: 0, imageNames: [] }), OptionError); // no ID
  // Text is reduced to what the standard fonts draw.
  assert.equal(winAnsi("Zoë 名前\u0007 ok", "f", 100), "Zoë ?? ok");
  assert.throws(() => winAnsi("\u0001", "f", 10), OptionError);
});
