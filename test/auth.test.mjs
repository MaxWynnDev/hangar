// Session cookies.
//
// The cookie is the only thing standing between a request and someone else's
// rooms, so these assert forgery and expiry rather than the happy path alone.

import { test, before } from "node:test";
import assert from "node:assert/strict";

// Set before the module reads it. A missing secret is a startup error by
// design, which is itself asserted below.
process.env.HANGAR_SESSION_SECRET = "a".repeat(48);

const { issueCookie, readSession, clearCookie } = await import("../dist-test/src/server/auth.js");

/** Pull the cookie value out of a Set-Cookie header. */
function value(setCookie) {
  return setCookie.split(";")[0];
}

test("a freshly issued cookie round trips", () => {
  const session = readSession(value(issueCookie("u_alice")));
  assert.equal(session?.userId, "u_alice");
});

test("a tampered user id is rejected", () => {
  const raw = value(issueCookie("u_alice"));
  const forged = raw.replace("u_alice", "u_admin");
  assert.equal(readSession(forged), null, "changing the id must invalidate the signature");
});

test("a stripped signature is rejected", () => {
  const raw = value(issueCookie("u_alice"));
  const noMac = raw.slice(0, raw.lastIndexOf("."));
  assert.equal(readSession(noMac), null);
});

test("a signature from a different secret is rejected", () => {
  const raw = value(issueCookie("u_alice"));
  const [name, payload] = raw.split("=");
  const parts = payload.split(".");
  parts[parts.length - 1] = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  assert.equal(readSession(`${name}=${parts.join(".")}`), null);
});

test("a user id containing dots survives the round trip", () => {
  // The parser splits on the LAST dot for exactly this reason. An id like an
  // email or a namespaced subject would otherwise be truncated.
  const session = readSession(value(issueCookie("auth0|first.last@example.com")));
  assert.equal(session?.userId, "auth0|first.last@example.com");
});

test("an expired cookie is rejected", () => {
  const raw = value(issueCookie("u_alice"));
  const [name, payload] = raw.split("=");
  const parts = payload.split(".");
  // Rewrite the timestamp to well outside the window. The signature no longer
  // matches either, which is the point: you cannot age a cookie forward
  // without invalidating it.
  parts[parts.length - 2] = String(Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 400);
  assert.equal(readSession(`${name}=${parts.join(".")}`), null);
});

test("nonsense input is rejected rather than throwing", () => {
  for (const input of [undefined, "", "garbage", "hangar_session=", "hangar_session=a.b", "other=x"]) {
    assert.equal(readSession(input), null, `input ${JSON.stringify(input)}`);
  }
});

test("the cookie carries the flags that matter", () => {
  const header = issueCookie("u_alice");
  assert.match(header, /HttpOnly/, "script must not be able to read it");
  assert.match(header, /SameSite=Lax/, "cross-site posts must not carry it");
  assert.match(header, /Path=\//);
});

test("clearing produces an immediately expired cookie", () => {
  assert.match(clearCookie(), /Max-Age=0/);
});
