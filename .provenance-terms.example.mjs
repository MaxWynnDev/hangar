// Example term list. Copy to .provenance-terms.mjs and put your real terms in it.
//
// The real file is gitignored, so the terms you want kept out of this repo are
// never in this repo. What ships here is the mechanism and this example, which
// is also what CI runs against.
//
// Each rule declares strings it MUST catch and, where a term is ordinary
// English in some contexts, strings it must NOT catch.
// test/leak-gate.test.mjs asserts both directions for every rule you add, so a
// rule that quietly stopped matching fails the build.

/** @type {import("./scripts/leak-rules.mjs").TermRule[]} */
export const TERM_RULES = [
  {
    id: "client-name",
    pattern: /acmecorp/gi,
    why: "the name of a private product",
    mustCatch: ["built for the AcmeCorp team", "no acmecorp user with that email"],
  },
  {
    id: "client-services",
    pattern: /\b(widget[-_]bus|widgetBus|SPROCKET_\w+)\b/gi,
    why: "internal service names from a private codebase",
    mustCatch: [
      "publish it on the widget-bus",
      "SPROCKET_ACCEPT_COMMANDS=1",
      "lib/widgetBus/ingest.ts",
    ],
  },
  {
    id: "client-domain-vocab",
    pattern: /\b(sprockets?|flanges?)\b/gi,
    why: "domain vocabulary specific to a private product's industry",
    // A carve-out for a context where the term is ordinary English rather than
    // domain vocabulary. Each one needs a reason, and this list should only
    // ever shrink.
    allow: [/\bflange\s+(bolt|gasket)/i],
    mustCatch: ["the sprocket ships tomorrow", "count the flanges"],
    mustAllow: ["tighten the flange bolt first"],
  },
];
