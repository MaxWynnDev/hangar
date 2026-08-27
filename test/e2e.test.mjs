// End to end, against a real server and a real database.
//
// Everything else tests a layer. This drives the actual flow a person and a
// companion perform: sign in, make a room, say something, mention the agent,
// let the companion claim the request, stream console rows, post a reply, and
// see it arrive in the room.
//
// It boots the built server as a child process, so it exercises the real
// routing, the real cookie, the real rate limits and the real policies. A test
// that imported the handlers directly would skip all of that.
//
//   DATABASE_URL=postgres://... npm run test:e2e

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import postgres from "postgres";

const ADMIN_URL = process.env.DATABASE_URL;
if (!ADMIN_URL) {
  console.error("DATABASE_URL is not set. This test requires a real database.");
  process.exit(1);
}

const PORT = 4123;
const BASE = `http://127.0.0.1:${PORT}`;
const COMPANION_TOKEN = randomBytes(32).toString("hex");
const APP_PASSWORD = "hangar-test-app";

let admin;
let server;
let cookie = "";

const EMAIL = "e2e@example.test";
const USER_ID = "u_e2e";

async function waitForServer(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/me`);
      // 401 is a fine answer: it means the server is up and routing.
      if (r.status === 401 || r.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not start in time");
}

/** Fetch carrying the session cookie, like a browser. */
async function as(path, opts = {}) {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: { "content-type": "application/json", cookie, ...(opts.headers ?? {}) },
  });
  const set = r.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const body = r.status === 204 ? null : await r.json().catch(() => null);
  return { status: r.status, body };
}

/** Fetch as the companion, with its bearer token. */
async function asCompanion(path, body) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${COMPANION_TOKEN}` },
    body: JSON.stringify(body ?? {}),
  });
  return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) };
}

before(async () => {
  admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`ALTER ROLE hangar_app WITH LOGIN PASSWORD '${APP_PASSWORD}'`);

  await admin`DELETE FROM users WHERE id = ${USER_ID}`;
  await admin`INSERT INTO users (id, email, name) VALUES (${USER_ID}, ${EMAIL}, 'E2E')`;
  await admin`INSERT INTO hangar_members (user_id) VALUES (${USER_ID}) ON CONFLICT DO NOTHING`;

  const appUrl = new URL(ADMIN_URL);
  appUrl.username = "hangar_app";
  appUrl.password = APP_PASSWORD;

  server = spawn(process.execPath, ["dist/src/server/index.js"], {
    env: {
      ...process.env,
      DATABASE_URL: appUrl.toString(),
      PORT: String(PORT),
      HANGAR_BIND: "127.0.0.1",
      HANGAR_SESSION_SECRET: randomBytes(32).toString("hex"),
      HANGAR_COMPANION_TOKEN: COMPANION_TOKEN,
      HANGAR_TRUSTED_LOGIN: "true",
      HANGAR_INSECURE_COOKIES: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

  await waitForServer();
});

after(async () => {
  if (server) server.kill();
  if (admin) {
    await admin`DELETE FROM users WHERE id = ${USER_ID}`;
    await admin.end({ timeout: 5 });
  }
});

test("the page renders without a session", async () => {
  const r = await fetch(BASE + "/");
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /<title>Hangar<\/title>/);
  // The strict policy is part of the product, not decoration.
  assert.match(r.headers.get("content-security-policy") ?? "", /default-src 'none'/);
});

test("the api refuses an anonymous request", async () => {
  const { status } = await as("/api/rooms");
  assert.equal(status, 401);
});

test("the companion path refuses a wrong token", async () => {
  const r = await fetch(BASE + "/api/companion/claim", {
    method: "POST",
    headers: { authorization: "Bearer " + "x".repeat(COMPANION_TOKEN.length) },
  });
  assert.equal(r.status, 401);
});

test("signing in and creating a room", async () => {
  const login = await as("/api/login", { method: "POST", body: JSON.stringify({ email: EMAIL }) });
  assert.equal(login.status, 200);
  assert.ok(cookie.includes("hangar_session="), "a session cookie must come back");

  const me = await as("/api/me");
  assert.equal(me.body.userId, USER_ID);

  const created = await as("/api/rooms", {
    method: "POST",
    body: JSON.stringify({ slug: "e2e-room", name: "E2E", session: true }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.room.isSession, true);
});

test("an unknown email does not reveal itself", async () => {
  const saved = cookie;
  cookie = "";
  const r = await as("/api/login", { method: "POST", body: JSON.stringify({ email: "nobody@example.test" }) });
  assert.equal(r.status, 200, "the response must not distinguish a real address from a fake one");
  const me = await as("/api/me");
  assert.equal(me.status, 401, "but no session is issued");
  cookie = saved;
});

test("posting a message, then dispatching the agent", async () => {
  const rooms = await as("/api/rooms");
  const room = rooms.body.rooms.find((r) => r.slug === "e2e-room");
  assert.ok(room, "the room we just made must be listed");

  const plain = await as(`/api/rooms/${room.id}/posts`, {
    method: "POST",
    body: JSON.stringify({ body: "morning all" }),
  });
  assert.equal(plain.status, 201);
  assert.equal(plain.body.dispatched, null, "an ordinary message must not start a session");

  const mention = await as(`/api/rooms/${room.id}/posts`, {
    method: "POST",
    body: JSON.stringify({ body: "@claude please look at the flaky test" }),
  });
  assert.equal(mention.status, 201);
  assert.ok(mention.body.dispatched, "a mention must queue a dispatch");

  // A second live dispatch in the same room is refused by the index, and the
  // message still posts. The room can see a session is already running.
  const second = await as(`/api/rooms/${room.id}/posts`, {
    method: "POST",
    body: JSON.stringify({ body: "@claude and this one too" }),
  });
  assert.equal(second.status, 201);
  assert.equal(second.body.dispatched, null, "one live dispatch per room");

  // --- now play the companion ---
  const claimed = await asCompanion("/api/companion/claim");
  assert.equal(claimed.status, 200);
  assert.equal(claimed.body.roomId, room.id);
  assert.match(claimed.body.ask, /flaky test/);
  assert.ok(!claimed.body.ask.startsWith("@claude"), "the handle is stripped from the ask");

  const again = await asCompanion("/api/companion/claim");
  assert.equal(again.status, 204, "the same request must not be handed out twice");

  await asCompanion("/api/companion/start", { id: claimed.body.id });

  const events = await asCompanion("/api/companion/events", {
    events: [
      { commandId: claimed.body.id, roomId: room.id, seq: 0, kind: "status", label: "starting" },
      { commandId: claimed.body.id, roomId: room.id, seq: 1, kind: "tool", label: "Read",
        metadata: { verb: "Read", object: "login.test.ts", tone: "read" } },
    ],
  });
  assert.equal(events.status, 204);

  // Replaying the same batch must not duplicate the console.
  await asCompanion("/api/companion/events", {
    events: [{ commandId: claimed.body.id, roomId: room.id, seq: 0, kind: "status", label: "starting" }],
  });

  const console1 = await as(`/api/rooms/${room.id}/events`);
  assert.equal(console1.body.events.length, 2, "a replayed batch is idempotent");

  // The cursor is room-wide, not per dispatch. seq restarts at zero for every
  // session, so a client holding seq=1 from this run would never see the next
  // session's rows at all.
  const cursor = console1.body.events[console1.body.events.length - 1].roomSeq;
  assert.ok(Number(cursor) > 0, "every event carries a room cursor");
  const none = await as(`/api/rooms/${room.id}/events?since=${cursor}`);
  assert.equal(none.body.events.length, 0, "nothing newer than the cursor yet");

  // Junk in the cursor must not 500.
  const junk = await as(`/api/rooms/${room.id}/events?since=not-a-number`);
  assert.equal(junk.status, 200, "an unparseable cursor falls back rather than erroring");

  // roomId is sent deliberately wrong here. The server must derive the room
  // from the dispatch and ignore this, or a companion with a bug (or a stolen
  // token) could deliver a reply into a room that never asked for one.
  const finished = await asCompanion("/api/companion/finish", {
    id: claimed.body.id,
    roomId: "room_does_not_exist",
    status: "done",
    reply: "Found it: the test asserted on wall clock time.",
  });
  assert.equal(finished.status, 200);
  assert.equal(finished.body.ok, true);

  const posts = await as(`/api/rooms/${room.id}/posts`);
  const agentPost = posts.body.posts.find((p) => p.authorKind === "agent");
  assert.ok(agentPost, "the agent's reply must appear in the room");
  assert.match(agentPost.body, /wall clock time/);
  assert.equal(agentPost.authorUserId, null, "an agent post carries no user id");

  // The room is free for another dispatch now.
  const third = await as(`/api/rooms/${room.id}/posts`, {
    method: "POST",
    body: JSON.stringify({ body: "@claude thanks, one more thing" }),
  });
  assert.ok(third.body.dispatched, "a finished room accepts a new request");
});

test("a secret in the agent's reply is redacted on the way into the room", async () => {
  const rooms = await as("/api/rooms");
  const room = rooms.body.rooms.find((r) => r.slug === "e2e-room");
  const fake = "sk-" + "ant-api03-" + "Z".repeat(24);

  const claimed = await asCompanion("/api/companion/claim");
  assert.equal(claimed.status, 200);

  const out = await asCompanion("/api/companion/finish", {
    id: claimed.body.id,
    status: "done",
    reply: `I used the key ${fake} to check`,
  });
  assert.equal(out.body.scrubbed, 1, "the scrub must be reported, not silent");

  const posts = await as(`/api/rooms/${room.id}/posts`);
  const latest = posts.body.posts.filter((p) => p.authorKind === "agent").pop();
  assert.ok(!latest.body.includes(fake), "the key must not be durable in the room");
  assert.match(latest.body, /\[redacted\]/);
});

test("reactions toggle and are attributed to the caller", async () => {
  const rooms = await as("/api/rooms");
  const room = rooms.body.rooms.find((r) => r.slug === "e2e-room");
  const posts = await as(`/api/rooms/${room.id}/posts`);
  const target = posts.body.posts[0];

  const on = await as(`/api/rooms/${room.id}/posts/${target.id}/reactions`, {
    method: "POST",
    body: JSON.stringify({ emoji: "👍" }),
  });
  assert.equal(on.body.added, true);

  const after1 = await as(`/api/rooms/${room.id}/posts`);
  const withRx = after1.body.posts.find((p) => p.id === target.id);
  assert.equal(withRx.reactions[0].count, 1);
  assert.equal(withRx.reactions[0].mine, true);

  const off = await as(`/api/rooms/${room.id}/posts/${target.id}/reactions`, {
    method: "POST",
    body: JSON.stringify({ emoji: "👍" }),
  });
  assert.equal(off.body.added, false, "clicking again removes it");

  const bad = await as(`/api/rooms/${room.id}/posts/${target.id}/reactions`, {
    method: "POST",
    body: JSON.stringify({ emoji: "not-an-emoji" }),
  });
  assert.equal(bad.status, 400, "reactions are an allowlist");
});
