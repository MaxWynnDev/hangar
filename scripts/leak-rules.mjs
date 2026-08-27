// What may never appear in this repository.
//
// Two kinds of rule. Structural rules are below: machine paths and
// credentials, which are the same everywhere and give nothing away by being
// written down. Term rules are the project-specific ones (client names,
// internal service names, industry vocabulary) and they live in
// `.provenance-terms.mjs`, which is gitignored.
//
// The term list stays out of the repo because a list of terms you want hidden
// is itself the thing you were hiding. `.provenance-terms.example.mjs` shows
// the format and is what CI runs against.
//
// If the real term list is ever committed by mistake, the gate scans it and
// fails on its own contents, which is the behaviour you want.
//
// Rules live apart from the CLI so `test/leak-gate.test.mjs` can prove every
// one of them actually fires.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * @typedef {object} TermRule
 * @property {string} id
 * @property {RegExp} pattern    Global; matched per line.
 * @property {string} why        Shown when it fires.
 * @property {RegExp[]} [allow]  Line contexts that are legitimate.
 * @property {string[]} mustCatch    Strings the rule MUST flag (asserted in tests).
 * @property {string[]} [mustAllow]  Strings the rule must NOT flag.
 */

// Fixtures below are assembled at runtime instead of written as literals, so
// this file doesn't contain the things it bans and needs no scan exemption.
// test/lib.test.mjs does the same for the same reason.
const BS = String.fromCharCode(92);

/**
 * Structural rules. Not project-specific, so they stay in the repo.
 * @type {TermRule[]}
 */
const STRUCTURAL_RULES = [
  {
    id: "local-paths",
    pattern: /(C:\\Users\\[A-Za-z0-9._-]+|\/Users\/[A-Za-z0-9._-]+|\/home\/[A-Za-z0-9._-]+)/g,
    why: "an absolute path from someone's machine",
    allow: [/\/Users\/<[a-z]+>/i, /C:\\Users\\<[a-z]+>/i, /\/home\/<[a-z]+>/i],
    mustCatch: [
      "/Users/" + "DP/hangar/index.ts",
      "C:" + BS + "Users" + BS + "someone" + BS + "hangar",
      "/home/" + "someone/hangar",
    ],
    mustAllow: ["put it under /Users/<you>/hangar"],
  },
  {
    id: "credentials",
    pattern: /(sk-ant-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|gho_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY)/g,
    why: "a credential",
    mustCatch: [
      "sk-" + "ant-api03-" + "A".repeat(24),
      "gh" + "p_" + "a".repeat(30),
      "AKI" + "A" + "IOSFODNN7EXAMPLE",
      "-----BEGIN " + "RSA PRIVATE KEY" + "-----",
    ],
  },
];

const REAL_TERMS = path.join(ROOT, ".provenance-terms.mjs");
const EXAMPLE_TERMS = path.join(ROOT, ".provenance-terms.example.mjs");

/** Where the term rules came from, so the CLI can say so out loud. */
export let termsSource;

/** True when running against the example list rather than a real one. */
export let termsAreExample = false;

const override = process.env.PROVENANCE_TERMS;
if (override) {
  const resolved = path.resolve(ROOT, override);
  if (!fs.existsSync(resolved)) {
    throw new Error(`PROVENANCE_TERMS points at ${resolved}, which does not exist`);
  }
  termsSource = resolved;
} else if (fs.existsSync(REAL_TERMS)) {
  termsSource = REAL_TERMS;
} else {
  termsSource = EXAMPLE_TERMS;
  termsAreExample = true;
}

const loaded = await import(pathToFileURL(termsSource).href);
const TERM_RULES = loaded.TERM_RULES;

if (!Array.isArray(TERM_RULES) || TERM_RULES.length === 0) {
  throw new Error(
    `${path.relative(ROOT, termsSource)} exported no TERM_RULES. ` +
      `A term file that loads but contributes nothing scans clean against everything.`
  );
}

/** @type {TermRule[]} */
export const RULES = [...TERM_RULES, ...STRUCTURAL_RULES];

/**
 * Scan one blob of text.
 * @param {string} text
 * @returns {{ ruleId: string, why: string, line: number, match: string, text: string }[]}
 */
export function scanText(text) {
  const findings = [];
  const lines = text.split("\n");
  for (const rule of RULES) {
    lines.forEach((line, i) => {
      if (rule.allow?.some((a) => a.test(line))) return;
      rule.pattern.lastIndex = 0;
      let m;
      while ((m = rule.pattern.exec(line)) !== null) {
        findings.push({
          ruleId: rule.id,
          why: rule.why,
          line: i + 1,
          match: m[0],
          text: line.trim().slice(0, 120),
        });
        if (!rule.pattern.global) break;
      }
    });
  }
  return findings;
}
