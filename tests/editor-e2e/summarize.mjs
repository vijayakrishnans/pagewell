// Turns Playwright's results.json into a step-summary table: each test in each browser, and the
// budget annotations (first-page-ms, first-load-bytes) against PW1's budgets.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] ?? "local";
const file = path.join(here, "results.json");
if (!fs.existsSync(file)) {
  console.log(`### editor e2e (${target})\n\nNo results.json: Playwright did not run.`);
  process.exit(0);
}
const report = JSON.parse(fs.readFileSync(file, "utf8"));
const rows = [];
const walk = (suite) => {
  for (const s of suite.suites ?? []) walk(s);
  for (const spec of suite.specs ?? []) {
    for (const t of spec.tests) {
      const r = t.results.at(-1) ?? {};
      const a = Object.fromEntries((t.annotations ?? []).map((x) => [x.type, x.description]));
      rows.push({ browser: t.projectName, title: spec.title, status: r.status ?? t.status, ms: r.duration, ...a });
    }
  }
};
walk(report);
const mb = (b) => (b ? `${(Number(b) / 1e6).toFixed(2)} MB` : "");
console.log(`### editor e2e (${target})\n`);
console.log("| browser | test | result | time | first page | first-load transfer |");
console.log("|---|---|---|---:|---:|---:|");
for (const r of rows) {
  const fp = r["first-page-ms"] ? `${r["first-page-ms"]} ms${Number(r["first-page-ms"]) > 2000 ? " ⚠ > 2 s" : ""}` : "";
  const fl = r["first-load-bytes"] ? `${mb(r["first-load-bytes"])}${Number(r["first-load-bytes"]) > 8e6 ? " ⚠ > 8 MB" : ""}` : "";
  console.log(`| ${r.browser} | ${r.title} | ${r.status} | ${r.ms ?? ""} ms | ${fp} | ${fl} |`);
}
