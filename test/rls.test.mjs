// Row level security, exercised against a real Postgres.
//
// These assert the claims the schema comments make. They are the difference
// between "the policies look right" and "a non-member gets zero rows".
//
// THE MOST IMPORTANT LINE IN THIS FILE is the guard in `before`: it refuses to
// run unless the connection is subject to RLS. A suite run as superuser, or as
// a BYPASSRLS role, or as the table owner without FORCE, passes every assertion
// below while proving absolutely nothing. That is the shape of a security test
// that quietly stops testing.
//
//   DATABASE_URL=postgres://... npm run test:db

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";

const ADMIN_URL = process.env.DATABASE_URL;
if (!ADMIN_URL) {
  console.error("DATABASE_URL is not set. These tests require a real database.");
  process.exit(1);
}

const APP_PASSWORD = "hangar-test-app";
let admin;
let app;

/** Run a callback with `app.user_id` set, the way the application does. */
async function asUser(userId, fn) {
  return app.begin(async (tx) => {
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    return fn(tx);
  });
}

const ids = {
  alice: "u_alice",
  bob: "u_bob",
  carol: "u_carol",
  privateRoom: "r_private",
  sessionRoom: "r_session",
  post: "p_1",
};

before(async () => {
  admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });

  // Give the app role a login for the duration of the suite.
  await admin.unsafe(`ALTER ROLE hangar_app WITH LOGIN PASSWORD '${APP_PASSWORD}'`);

  const u = new URL(ADMIN_URL);
  u.username = "hangar_app";
  u.password = APP_PASSWORD;
  app = postgres(u.toString(), { max: 2, onnotice: () => {} });

  // --- The guard. Without this the whole file is theatre. ---
  const [who] = await app`
    SELECT current_user AS role,
           (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_super,
           (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypasses
  `;
  assert.equal(who.role, "hangar_app", "tests must run as the application role");
  assert.equal(who.is_super, false, "a superuser bypasses RLS; this suite would prove nothing");
  assert.equal(who.bypasses, false, "BYPASSRLS set; this suite would prove nothing");

  // Every table the policies govern must be FORCED, not merely enabled.
  const tables = await admin`
    SELECT relname, relrowsecurity, relforcerowsecurity
    FROM pg_class
    WHERE relname IN ('rooms','room_members','room_posts','room_post_reactions',
                      'room_presence','hangar_members','hangar_sessions',
                      'dispatch_commands','session_events','room_attachments')
      AND relkind = 'r'
  `;
  assert.equal(tables.length, 10, "expected all ten governed tables to exist");
  for (const t of tables) {
    assert.ok(t.relrowsecurity, `${t.relname} does not have RLS enabled`);
    assert.ok(t.relforcerowsecurity, `${t.relname} is not FORCED; its owner bypasses it`);
  }

  // --- Fixtures, written as admin so setup never depends on the policies. ---
  await admin`DELETE FROM users WHERE id IN (${ids.alice}, ${ids.bob}, ${ids.carol})`;
  await admin`
    INSERT INTO users (id, email, name) VALUES
      (${ids.alice}, 'alice@example.test', 'Alice'),
      (${ids.bob},   'bob@example.test',   'Bob'),
      (${ids.carol}, 'carol@example.test', 'Carol')
  `;
  await admin`
    INSERT INTO rooms (id, slug, name, created_by) VALUES
      (${ids.privateRoom}, 'private-room', 'Private', ${ids.alice}),
      (${ids.sessionRoom}, 'session-room', 'Session', ${ids.alice})
  `;
  // Alice is in the private room. Bob is not.
  await admin`
    INSERT INTO room_members (id, room_id, user_id, role) VALUES
      ('m_1', ${ids.privateRoom}, ${ids.alice}, 'owner')
  `;
  await admin`
    INSERT INTO room_posts (id, room_id, author_kind, author_user_id, body)
    VALUES (${ids.post}, ${ids.privateRoom}, 'user', ${ids.alice}, 'secret')
  `;
  // The session room: nobody holds a membership row. Alice and Bob are on the
  // roster, Carol is not.
  await admin`INSERT INTO hangar_sessions (room_id, opened_by) VALUES (${ids.sessionRoom}, ${ids.alice})`;
  await admin`
    INSERT INTO hangar_members (user_id) VALUES (${ids.alice}), (${ids.bob})
  `;
});

after(async () => {
  if (admin) {
    await admin`DELETE FROM users WHERE id IN (${ids.alice}, ${ids.bob}, ${ids.carol})`;
    await admin`DELETE FROM rooms WHERE id IN (${ids.privateRoom}, ${ids.sessionRoom})`;
    await admin.end({ timeout: 5 });
  }
  if (app) await app.end({ timeout: 5 });
});

test("a member reads their room's posts", async () => {
  const rows = await asUser(ids.alice, (tx) => tx`SELECT id FROM room_posts WHERE room_id = ${ids.privateRoom}`);
  assert.equal(rows.length, 1);
});

test("a non-member reads zero rows, rather than getting an error", async () => {
  const rows = await asUser(ids.bob, (tx) => tx`SELECT id FROM room_posts WHERE room_id = ${ids.privateRoom}`);
  assert.equal(rows.length, 0, "Bob is not in the private room and must see nothing");
});

test("with no app.user_id the schema fails closed", async () => {
  // No set_config at all: the deliberate "silent empty" failure mode. It must
  // return nothing rather than everything.
  const rows = await app`SELECT id FROM room_posts`;
  assert.equal(rows.length, 0, "an unscoped connection must not read conversation");
});

test("a member cannot post as someone else", async () => {
  await assert.rejects(
    () =>
      asUser(ids.alice, (tx) =>
        tx`INSERT INTO room_posts (id, room_id, author_kind, author_user_id, body)
           VALUES ('p_forge', ${ids.privateRoom}, 'user', ${ids.bob}, 'not mine')`
      ),
    /row-level security/i,
    "authorship must be bound to the caller at INSERT"
  );
});

test("the app role cannot forge an agent post", async () => {
  await assert.rejects(
    () =>
      asUser(ids.alice, (tx) =>
        tx`INSERT INTO room_posts (id, room_id, author_kind, author_agent_id, body)
           VALUES ('p_fake_agent', ${ids.privateRoom}, 'agent', 'claude-code', 'I did it')`
      ),
    /row-level security/i,
    "an agent post must be impossible through the ordinary INSERT path"
  );
});

test("agent posts arrive only through the definer writer", async () => {
  await asUser(ids.alice, (tx) =>
    tx`SELECT app_post_agent_message('p_agent', ${ids.privateRoom}, 'claude-code', 'Claude', 'done', NULL, NULL)`
  );
  const rows = await asUser(ids.alice, (tx) =>
    tx`SELECT author_kind, author_agent_id, author_user_id FROM room_posts WHERE id = 'p_agent'`
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].author_kind, "agent");
  assert.equal(rows[0].author_agent_id, "claude-code");
  assert.equal(rows[0].author_user_id, null, "an agent post carries no user id");
});

test("a roster member reads a session room without a membership row", async () => {
  // This is arm 2 of app_is_room_member. Bob holds no room_members row here.
  const rows = await asUser(ids.bob, (tx) => tx`SELECT id FROM rooms WHERE id = ${ids.sessionRoom}`);
  assert.equal(rows.length, 1, "sessions are shared with the whole roster");
});

test("someone off the roster cannot read a session room", async () => {
  const rows = await asUser(ids.carol, (tx) => tx`SELECT id FROM rooms WHERE id = ${ids.sessionRoom}`);
  assert.equal(rows.length, 0, "Carol is not on the roster");
});

test("a private room is not reachable through the session arm", async () => {
  // Bob is on the roster but the private room has no hangar_sessions row, so
  // arm 2 cannot reach it. This is what keeps pre-session channels private.
  const rows = await asUser(ids.bob, (tx) => tx`SELECT id FROM rooms WHERE id = ${ids.privateRoom}`);
  assert.equal(rows.length, 0);
});

test("the roster cannot be written directly", async () => {
  await assert.rejects(
    () => asUser(ids.alice, (tx) => tx`INSERT INTO hangar_members (user_id) VALUES (${ids.carol})`),
    /permission denied|row-level security/i,
    "roster writes must go through app_add_hangar_member"
  );
});

test("a room cannot be converted to a session once it has posts", async () => {
  await assert.rejects(
    () => asUser(ids.alice, (tx) => tx`SELECT app_open_session(${ids.privateRoom})`),
    /already has posts/i,
    "converting a used room would republish its history to the whole roster"
  );
});

// --- roster gating -------------------------------------------------------
//
// Carol has a users row but is not on hangar_members. Before this was fixed
// she could create a room, make herself its owner, post in it, and queue a
// dispatch, which runs code on the companion's machine.

test("someone off the roster cannot create a room", async () => {
  await assert.rejects(
    () =>
      asUser(ids.carol, (tx) =>
        tx`INSERT INTO rooms (id, slug, name, created_by)
           VALUES ('r_carol', 'carol-room', 'Carol', ${ids.carol})`
      ),
    /row-level security/i,
    "room creation was the entry point to the whole chain"
  );
});

test("someone off the roster cannot queue a dispatch", async () => {
  await assert.rejects(
    () =>
      asUser(ids.carol, (tx) =>
        tx`INSERT INTO dispatch_commands (id, room_id, requested_by, ask, expires_at)
           VALUES ('d_carol', ${ids.privateRoom}, ${ids.carol}, 'run something', now() + interval '10 minutes')`
      ),
    /row-level security/i,
    "a dispatch is code execution on the companion machine"
  );
});

test("a membership row alone is not enough once off the roster", async () => {
  // Give Carol a real membership row, the way an admin would have.
  await admin`
    INSERT INTO room_members (id, room_id, user_id, role)
    VALUES ('m_carol', ${ids.privateRoom}, ${ids.carol}, 'member')
    ON CONFLICT DO NOTHING
  `;
  const rows = await asUser(ids.carol, (tx) =>
    tx`SELECT id FROM room_posts WHERE room_id = ${ids.privateRoom}`
  );
  assert.equal(rows.length, 0, "the roster is a precondition, not one of the arms");
  await admin`DELETE FROM room_members WHERE id = 'm_carol'`;
});

test("removing someone from the roster drops their room memberships", async () => {
  await admin`INSERT INTO hangar_members (user_id) VALUES (${ids.carol}) ON CONFLICT DO NOTHING`;
  await admin`
    INSERT INTO room_members (id, room_id, user_id, role)
    VALUES ('m_carol2', ${ids.privateRoom}, ${ids.carol}, 'member')
    ON CONFLICT DO NOTHING
  `;
  await asUser(ids.alice, (tx) => tx`SELECT app_remove_hangar_member(${ids.carol})`);

  const left = await admin`SELECT id FROM room_members WHERE user_id = ${ids.carol}`;
  assert.equal(left.length, 0, "removal that leaves memberships behind is not a removal");
});
