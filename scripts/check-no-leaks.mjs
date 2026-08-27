// The term gate. Runs pre-commit and in CI on every push.
//
// See scripts/leak-rules.mjs for the rules and test/leak-gate.test.mjs for the
// proof that each one fires.
//
//   node scripts/check-no-leaks.mjs             the working tree
//   node scripts/check-no-leaks.mjs --history   every blob in every commit
//
// Both matter, and the second is easy to forget. Something committed and then
// deleted leaves the working tree clean while it stays in history, readable by
// anyone who clones. Scanning only the tip reports success on exactly the
// failure this gate is for.

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { RULES, scanText, termsSource, termsAreExample } from "./leak-rules.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// The example list necessarily contains the terms it declares, and it is the
// only tracked file that does. The real list is gitignored, so it is never
// scanned, and if it ever gets committed the gate fails on it.
const EXEMPT = new Set([".provenance-terms.example.mjs"]);

const termsLabel = `${path.relative(ROOT, termsSource).replace(/\\/g, "/")}${
  termsAreExample ? " (EXAMPLE TERMS, not a real list)" : ""
}`;

const HISTORY = process.argv.includes("--history");

const git = (args) => execSync(`git ${args}`, { cwd: ROOT, encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });

let scanned = 0;
const findings = [];

if (!HISTORY) {
  const files = git("ls-files").split("\n").map((f) => f.trim()).filter(Boolean);
  if (files.length === 0) {
    console.error("No tracked files. Refusing to report a clean scan of nothing.");
    process.exit(1);
  }
  for (const rel of files) {
    if (EXEMPT.has(rel)) continue;
    let buf;
    try {
      buf = fs.readFileSync(path.join(ROOT, rel));
    } catch {
      continue;
    }
    if (buf.includes(0)) continue; // binary
    scanned += 1;
    for (const f of scanText(buf.toString("utf-8"))) findings.push({ ...f, where: rel });
  }
  console.error(`scanned ${scanned} tracked file(s) against ${RULES.length} rules from ${termsLabel}`);
} else {
  // Every object reachable from any ref, deduplicated by id. A path that was
  // deleted, or renamed, is still here. Tree objects are scanned too, on
  // purpose: their contents are a listing of names, so a leaked FILENAME is
  // caught even when the file's contents were innocent.
  const objects = git("rev-list --all --objects")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const sp = l.indexOf(" ");
      return sp === -1 ? null : { sha: l.slice(0, sp), path: l.slice(sp + 1) };
    })
    .filter((o) => o && o.path);

  if (objects.length === 0) {
    console.error("No objects in history. Refusing to report a clean scan of nothing.");
    process.exit(1);
  }

  const seen = new Set();
  for (const { sha, path: p } of objects) {
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (EXEMPT.has(p)) continue;
    let buf;
    try {
      buf = execSync(`git cat-file -p ${sha}`, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
    } catch {
      continue;
    }
    if (buf.includes(0)) continue; // binary
    scanned += 1;
    for (const f of scanText(buf.toString("utf-8"))) {
      findings.push({ ...f, where: `${p} (object ${sha.slice(0, 8)})` });
    }
  }
  console.error(
    `scanned ${scanned} object(s) across all history against ${RULES.length} rules from ${termsLabel}`
  );
}

if (findings.length > 0) {
  console.error(`\nLEAK: ${findings.length} finding(s)\n`);
  for (const f of findings) {
    console.error(`  ${f.where}:${f.line}  [${f.ruleId}]  "${f.match}"`);
    console.error(`    ${f.text}`);
    console.error(`    why: ${f.why}\n`);
  }
  process.exit(1);
}

console.error("clean");
