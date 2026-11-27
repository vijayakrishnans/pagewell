#!/usr/bin/env node
// THE BRAND CHECK: no ArtCraft or PdfCraft mark on a surface a Pagewell user sees.
//
// ArtCraft's and PdfCraft's names, wordmarks, logos and app icons are trademarks, not open source
// (ATTRIBUTION.md). Pagewell may name PdfCraft only in descriptive sentences and notices ("built
// on PdfCraft", "Not affiliated with ArtCraft"), never as its own mark.
//
// What is checked (vendor/ is upstream's source and is not a surface by itself):
//   - the text a user can see in apps/** and crates/pagewell-*/**: string literals and markup
//     text, not comments, identifiers or import paths;
//   - file names: no asset under apps/ or crates/ named after either mark.
//
//   node tooling/brand-check/check.mjs [--root <repo>]    exit 1 and list each hit
//
// Node only. No dependencies.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MARK = /art\s*craft|pdf\s*craft/i;
// Descriptive sentences and notices that may name the marks.
export const ALLOWED = [
  /built on PdfCraft/i,
  /not affiliated with (ArtCraft|PdfCraft)/i,
  /PdfCraft \(MIT OR Apache-2\.0\)/i,
];
const ROOTS = ["apps", "crates"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".next", ".open-next", ".wrangler", ".turbo", "target", ".artifact-cache", "coverage", "docs"]);
const TEXT = /\.(rs|ts|tsx|js|mjs|jsx|html|css|json|svg|md|txt|ftl|toml|jsonc)$/;
const ASSET = /\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|otf)$/;
// Files whose text is not shown to users (manifests name crates; tests name upstream).
const NOT_A_SURFACE = /(^|\/)(Cargo\.toml|package\.json|tsconfig\.json|component\.yaml|clippy\.toml|README\.md)$|\.test\.m?[jt]sx?$|(^|\/)(tests?|scripts)\//;

/** The text in `source` a user could see: string literals and markup text, comments removed. */
export function visibleText(source, file) {
  const ext = path.extname(file);
  let s = source;
  if (ext === ".html" || ext === ".svg") {
    s = s.replace(/<!--[\s\S]*?-->/g, "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
    const out = [];
    for (const m of s.matchAll(/>([^<]+)</g)) out.push(m[1]);
    for (const m of s.matchAll(/\b(?:title|alt|aria-label|content|placeholder|value)="([^"]*)"/gi)) out.push(m[1]);
    return out;
  }
  if (ext === ".md" || ext === ".txt" || ext === ".ftl") return s.split("\n");
  if (ext === ".css") return [...s.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/content:\s*"([^"]*)"/g)].map((m) => m[1]);
  // Rust: a test module is not a surface (by convention it closes the file).
  if (ext === ".rs") s = s.replace(/#\[cfg\(test\)\][\s\S]*$/, "");
  // Code: drop comments, then keep string literals (and JSX text) that are not module paths.
  s = s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  const out = [];
  for (const m of s.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
    const lit = m[1] ?? m[2] ?? m[3] ?? "";
    const before = s.slice(Math.max(0, m.index - 12), m.index);
    if (/(from|import|require\(|use)\s*$/.test(before)) continue;
    out.push(lit);
  }
  if (ext === ".tsx" || ext === ".jsx") for (const m of s.matchAll(/>([^<>{}]+)</g)) out.push(m[1]);
  return out;
}

export function hitsIn(text) {
  return MARK.test(text) && !ALLOWED.some((re) => re.test(text));
}

export function check(root) {
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const rel = path.relative(root, p).split(path.sep).join("/");
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p);
        continue;
      }
      if (rel.startsWith("crates/") && !rel.startsWith("crates/pagewell-")) continue;
      if (ASSET.test(e.name) && MARK.test(e.name)) hits.push(`${rel}: an asset named after a mark`);
      if (!TEXT.test(e.name) || NOT_A_SURFACE.test(rel)) continue;
      for (const text of visibleText(fs.readFileSync(p, "utf8"), e.name)) {
        if (hitsIn(text)) hits.push(`${rel}: "${text.trim().slice(0, 120)}"`);
      }
    }
  };
  for (const r of ROOTS) if (fs.existsSync(path.join(root, r))) walk(path.join(root, r));
  return hits;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--root");
  const root = path.resolve(i >= 0 ? process.argv[i + 1] : path.join(path.dirname(fileURLToPath(import.meta.url)), "../.."));
  const hits = check(root);
  if (hits.length) {
    console.error(`✕ brand check: ${hits.length} ArtCraft/PdfCraft mark(s) on user-visible surfaces:`);
    for (const h of hits) console.error(`  ${h}`);
    console.error("Name PdfCraft only in a descriptive sentence (\"built on PdfCraft\"); see ATTRIBUTION.md.");
    process.exit(1);
  }
  console.log("✓ brand check: no ArtCraft or PdfCraft marks on user-visible surfaces");
}
