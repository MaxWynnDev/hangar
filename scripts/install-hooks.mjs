// Install the pre-commit term hook.
//
// CI catching a leak means it is already in history, and history is the part
// that cannot be quietly fixed later. This stops it at the commit instead.
//
// Git hooks are not installed by cloning, so this runs from `npm run prepare`.

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

let hooksDir;
try {
  const gitDir = execSync("git rev-parse --git-dir", { cwd: ROOT, encoding: "utf-8" }).trim();
  hooksDir = path.resolve(ROOT, gitDir, "hooks");
} catch {
  console.error("not a git checkout; skipping hook install");
  process.exit(0);
}

fs.mkdirSync(hooksDir, { recursive: true });

const hook = `#!/bin/sh
# Term gate. Installed by scripts/install-hooks.mjs.
# Bypass with --no-verify only if you know exactly why.
exec node "$(git rev-parse --show-toplevel)/scripts/check-no-leaks.mjs"
`;

const target = path.join(hooksDir, "pre-commit");
fs.writeFileSync(target, hook, { mode: 0o755 });
console.error(`installed ${path.relative(ROOT, target)}`);
