#!/usr/bin/env node
// THE EDITOR BUNDLE, BUILT ONCE BY THE RUST LANE AND PINNED HERE.
//
// The editor is PdfCraft's egui app compiled to wasm (crates/pagewell-web-bridge). Compiling it
// takes the better part of an hour, so deploys never do: the Rust CI lane builds it on main and
// publishes it, content-addressed, on one rolling `editor-artifacts` release; this app pins the
// asset it serves (editor-artifact.pin.json: url, sha256, sourceHash) and its build fetches and
// verifies it.
//
//   hash  [--root <repo>]                 print the hash of the Rust sources the bundle is built from
//   pack  --in <wasm-bindgen out dir>     brotli the wasm (names already stripped by wasm-bindgen; Assets take
//         --out <dir> [--root <repo>]     files ≤ 25 MiB; the worker serves it Content-Encoding br) and
//                                         tar it as editor-<hash>.tar.gz (+ .sha256)
//   build [--root <repo>]                 (the component's build) fetch the pinned bundle, verify it,
//                                         and write dist/: the page, the bundle under pkg/<hash>/ and
//                                         the generated fixtures
//
// Node + the system `tar` and `git`. No dependencies.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import { fixturePdf } from "./fixture.mjs";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PIN = path.join(APP, "editor-artifact.pin.json");
const RELEASE = "editor-artifacts";
// What decides the editor bundle, relative to the repo root.
export const SOURCES = ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", ".cargo", "crates", "vendor/pdfcraft"];
// Static Assets' per-file limit.
const MAX_ASSET = 25 * 1024 * 1024;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

function fail(message) {
  console.error(`✕ editor-artifact: ${message}`);
  process.exit(1);
}

function repoRoot() {
  return path.resolve(arg("root", path.join(APP, "../..")));
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** The hash of the committed Rust sources (git's tree entries, so it is the same on any clone). */
export function sourceHash(root) {
  const tree = execFileSync("git", ["-C", root, "ls-tree", "-r", "HEAD", "--", ...SOURCES], { encoding: "utf8", maxBuffer: 256 << 20 });
  if (!tree.trim()) fail(`no Rust sources at HEAD in ${root}`);
  return sha256(tree).slice(0, 32);
}

function pack() {
  const root = repoRoot();
  const input = path.resolve(arg("in") ?? fail("--in is required"));
  const out = path.resolve(arg("out") ?? fail("--out is required"));
  const hash = sourceHash(root);
  const stage = path.join(out, `editor-${hash}`);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  fs.cpSync(input, stage, { recursive: true });
  for (const f of fs.readdirSync(stage).filter((f) => f.endsWith(".wasm"))) {
    const raw = fs.readFileSync(path.join(stage, f));
    const br = zlib.brotliCompressSync(raw, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_LGWIN]: 24, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length },
    });
    if (br.length > MAX_ASSET) fail(`${f}.br is ${br.length} B, over the ${MAX_ASSET} B Static Assets limit`);
    fs.writeFileSync(path.join(stage, `${f}.br`), br);
    fs.rmSync(path.join(stage, f));
    console.log(`${f}: raw ${raw.length} B, brotli ${br.length} B`);
  }
  const tarball = path.join(out, `editor-${hash}.tar.gz`);
  execFileSync("tar", ["-czf", tarball, "-C", stage, "."]);
  const digest = sha256(fs.readFileSync(tarball));
  fs.writeFileSync(`${tarball}.sha256`, `${digest}  ${path.basename(tarball)}\n`);
  console.log(JSON.stringify({ asset: path.basename(tarball), sha256: digest, sourceHash: hash }));
}

async function fetchVerified(pin) {
  const cache = path.join(APP, ".artifact-cache", `${pin.sha256}.tar.gz`);
  if (fs.existsSync(cache) && sha256(fs.readFileSync(cache)) === pin.sha256) return cache;
  const res = await fetch(pin.url, { redirect: "follow" });
  if (!res.ok) fail(`fetching ${pin.url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== pin.sha256) fail(`sha256 mismatch for ${pin.url}: pinned ${pin.sha256}, got ${got}`);
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(cache, buf);
  return cache;
}

async function build() {
  if (!fs.existsSync(PIN)) fail(`no ${path.basename(PIN)}: pin a bundle the Rust lane published on the ${RELEASE} release`);
  const pin = JSON.parse(fs.readFileSync(PIN, "utf8"));
  for (const k of ["url", "sha256", "sourceHash"]) if (!pin[k]) fail(`${path.basename(PIN)} has no ${k}`);
  if (!/^[0-9a-f]{32}$/.test(pin.sourceHash)) fail("sourceHash must be 32 hex characters");

  try {
    const now = sourceHash(repoRoot());
    if (now !== pin.sourceHash) console.warn(`! editor-artifact: the Rust sources now hash to ${now}; the pinned bundle was built from ${pin.sourceHash}. Re-pin after the Rust lane publishes.`);
  } catch {
    // Not a git checkout (a packed build): the pin is the source of truth.
  }

  const tarball = await fetchVerified(pin);
  const dist = path.join(APP, "dist");
  fs.rmSync(dist, { recursive: true, force: true });
  const pkg = path.join(dist, "pkg", pin.sourceHash);
  fs.mkdirSync(pkg, { recursive: true });
  execFileSync("tar", ["-xzf", tarball, "-C", pkg]);

  for (const f of fs.readdirSync(path.join(APP, "public"))) {
    const src = path.join(APP, "public", f);
    const text = f.endsWith(".html") ? fs.readFileSync(src, "utf8").replaceAll("__PKG__", pin.sourceHash) : null;
    if (text !== null) fs.writeFileSync(path.join(dist, f), text);
    else fs.cpSync(src, path.join(dist, f), { recursive: true });
  }

  fs.mkdirSync(path.join(dist, "fixtures"), { recursive: true });
  fs.writeFileSync(path.join(dist, "fixtures", "fixture.pdf"), fixturePdf(100));

  for (const f of walk(dist)) {
    const size = fs.statSync(f).size;
    if (size > MAX_ASSET) fail(`${path.relative(dist, f)} is ${size} B, over the Static Assets limit`);
  }
  console.log(`✓ editor-artifact: dist/ built from bundle ${pin.sourceHash}`);
}

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  if (cmd === "hash") console.log(sourceHash(repoRoot()));
  else if (cmd === "pack") pack();
  else if (cmd === "build") await build();
  else fail("usage: editor-artifact.mjs hash|pack|build");
}
