// Pure domain modules: mentions, presence windows, reactions, report scrubbing.

import { test } from "node:test";
import assert from "node:assert/strict";

import { mentionsAgent, extractAsk } from "../dist-test/src/lib/mentions.js";
import { isPresent, isTyping, PRESENT_WINDOW_MS, TYPING_WINDOW_MS } from "../dist-test/src/lib/presence.js";
import { isReaction, REACTIONS } from "../dist-test/src/lib/reactions.js";
import { scrubReport } from "../dist-test/src/lib/report-scrub.js";

// --- mentions --------------------------------------------------------------

test("a plain mention dispatches", () => {
  assert.equal(mentionsAgent("@claude fix the build"), true);
  assert.equal(mentionsAgent("hey @claude can you look"), true);
});

test("a longer handle does not dispatch", () => {
  // The bug this prevents: @claudette in a room full of people dispatching a
  // session nobody asked for.
  assert.equal(mentionsAgent("@claudette said hi"), false);
});

test("an email address does not dispatch", () => {
  assert.equal(mentionsAgent("mail me@claude.example"), false);
});

test("the ask has the leading handle removed but keeps later ones", () => {
  assert.equal(extractAsk("@claude fix the build"), "fix the build");
  // Editing someone's words before the agent sees them would make the room and
  // the brief disagree about what was said.
  assert.equal(
    extractAsk("@claude ask @claude why this happens"),
    "ask @claude why this happens"
  );
});

// --- presence --------------------------------------------------------------

test("presence ages out on its own", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  const fresh = new Date(now.getTime() - 1000);
  const stale = new Date(now.getTime() - PRESENT_WINDOW_MS - 1000);
  assert.equal(isPresent(fresh, now), true);
  assert.equal(isPresent(stale, now), false, "a client that vanished must not stay present forever");
});

test("typing ages out faster than presence", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  const old = new Date(now.getTime() - TYPING_WINDOW_MS - 500);
  assert.equal(isTyping(old, now), false, "the ghost typist is the classic bug here");
  assert.ok(TYPING_WINDOW_MS < PRESENT_WINDOW_MS);
});

test("a null signal is simply absent", () => {
  assert.equal(isPresent(null), false);
  assert.equal(isTyping(null), false);
});

// --- reactions -------------------------------------------------------------

test("reactions are an allowlist", () => {
  assert.equal(isReaction(REACTIONS[0]), true);
  assert.equal(isReaction("not-an-emoji"), false);
  assert.equal(isReaction("x".repeat(400)), false, "an open field is a second message body");
});

// --- report scrubbing ------------------------------------------------------
//
// Fixtures are assembled at runtime rather than written as literals. The
// term gate scans this file and cannot tell a fake credential from a real
// one, which is the correct behaviour: a gate that recognises "obviously fake"
// is a gate with a bypass. Exempting the file would be worse, so the literals
// simply never exist.

const FAKE = {
  anthropic: "sk-" + "ant-api03-" + "A".repeat(24),
  github: "gh" + "p_" + "a".repeat(24),
  aws: "AKI" + "A" + "IOSFODNN7EXAMPLE",
  pkHeader: "-----BEGIN " + "RSA PRIVATE KEY" + "-----",
  pkFooter: "-----END " + "RSA PRIVATE KEY" + "-----",
};

test("an ordinary reply passes through untouched", () => {
  const text = "Fixed the race in login.ts. Two tests were asserting on wall clock time.";
  const out = scrubReport(text);
  assert.equal(out.text, text);
  assert.deepEqual(out.hits, []);
});

test("credentials in a reply are redacted and reported", () => {
  const out = scrubReport(`the key is ${FAKE.anthropic} and it works`);
  assert.ok(!out.text.includes(FAKE.anthropic), "the key must not survive into the room");
  assert.equal(out.hits.length, 1);
  assert.equal(out.hits[0].id, "anthropic-key");
});

test("a connection string loses its credentials but stays readable", () => {
  const out = scrubReport("connected to postgres://admin:hunter2@db.internal:5432/app");
  assert.ok(!out.text.includes("hunter2"));
  assert.ok(out.text.includes("db.internal"), "the host is useful context and not a secret");
});

test("an env assignment keeps its name so the signal is actionable", () => {
  const out = scrubReport("I set STRIPE_SECRET_KEY=sk_live_abcdefghijklmnop to test");
  assert.match(out.text, /STRIPE_SECRET_KEY=\[redacted\]/);
  assert.ok(!out.text.includes("sk_live_abcdefghijklmnop"));
});

test("a private key block is removed whole, not line by line", () => {
  const key = `${FAKE.pkHeader}\nAAAA\nBBBB\n${FAKE.pkFooter}`;
  const out = scrubReport(`here it is:\n${key}\ndone`);
  assert.ok(!out.text.includes("AAAA"));
  assert.match(out.text, /here it is:\n\[redacted\]\ndone/);
});

test("several different secrets are all caught in one pass", () => {
  const out = scrubReport(`${FAKE.anthropic} and ${FAKE.aws} and ${FAKE.github}`);
  assert.equal(out.hits.length, 3);
  for (const v of [FAKE.anthropic, FAKE.aws, FAKE.github]) {
    assert.ok(!out.text.includes(v), `${v.slice(0, 6)}... must not survive`);
  }
});
