// Proof that the term gate can fail.
//
// The gate's value is the claim "none of the listed terms are in this repo."
// A scan that returns zero findings looks identical whether it examined
// everything or nothing. So every rule declares strings it MUST catch, and the
// contexts it must stay quiet about, and this asserts both.
//
// Adding a rule without a mustCatch is a test failure, not an oversight.
//
// CI runs these against .provenance-terms.example.mjs. Locally they run
// against whatever .provenance-terms.mjs holds. Either way each loaded rule
// has to prove itself.

import { test } from "node:test";
import assert from "node:assert/strict";

import { RULES, scanText, termsSource } from "../scripts/leak-rules.mjs";

test("a term list actually loaded", () => {
  assert.ok(termsSource, "no term file was resolved");
  // Structural rules alone would scan clean against every project term, and
  // report success doing it.
  assert.ok(
    RULES.length > 2,
    `only ${RULES.length} rules loaded from ${termsSource}, which means no term rules came through`
  );
});

test("every rule declares something it must catch", () => {
  for (const rule of RULES) {
    assert.ok(
      Array.isArray(rule.mustCatch) && rule.mustCatch.length > 0,
      `rule "${rule.id}" has no mustCatch, so nothing proves it fires`
    );
  }
});

test("every rule fires on the material it exists to stop", () => {
  for (const rule of RULES) {
    for (const sample of rule.mustCatch) {
      const hits = scanText(sample).filter((f) => f.ruleId === rule.id);
      assert.ok(
        hits.length > 0,
        `rule "${rule.id}" did NOT flag ${JSON.stringify(sample)}. The gate would pass this through.`
      );
    }
  }
});

test("rules stay quiet on legitimate English", () => {
  for (const rule of RULES) {
    for (const sample of rule.mustAllow ?? []) {
      const hits = scanText(sample).filter((f) => f.ruleId === rule.id);
      assert.equal(
        hits.length,
        0,
        `rule "${rule.id}" wrongly flagged ${JSON.stringify(sample)} as ${JSON.stringify(hits[0]?.match)}. ` +
          `False positives get the gate switched off.`
      );
    }
  }
});

test("rule ids are unique", () => {
  const ids = RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate rule id in ${termsSource}`);
});

test("clean text produces no findings", () => {
  const clean = [
    "export function markRoomRead(roomId: string) {",
    "  // Advance the read cursor for this member.",
    "  return db.execute(sql`select app_mark_room_read(${roomId})`);",
    "}",
  ].join("\n");
  assert.deepEqual(scanText(clean), []);
});

// Note: no test here hardcodes a banned string. Real fixtures live in each
// rule's `mustCatch` inside the term file, and the only tracked one is the
// example. That leaves a single scan exemption instead of one per file.
