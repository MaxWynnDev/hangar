// The dispatch claim protocol, against a real Postgres.
//
// This is the path that ends in code execution on someone's machine, so the
// queue's guarantees are worth asserting rather than assuming: one claim per
// request, one live request per room, expiry honoured, completion idempotent.
//
//   DATABASE_URL=postgres://... npm run test:db

import { test, before, after, beforeEach } from "node:test";
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

const U = "u_dispatch_alice";
const R1 = "r_dispatch_one";
const R2 = "r_dispatch_two";

async function asUser(userId, fn) {
  return app.begin(async (tx) => {
    await tx`SELECT app_set_user(${userId})`;
    return fn(tx);
  });
}

before(async () => {
  admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`ALTER ROLE hangar_app WITH LOGIN PASSWORD '${APP_PASSWORD}'`);
  const u = new URL(ADMIN_URL);
  u.username = "hangar_app";
  u.password = APP_PASSWORD;
  app = postgres(u.toString(), { max: 2, onnotice: () => {} });

  const [who] = await app`
    SELECT current_user AS role,
           (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_super
  `;
  assert.equal(who.role, "hangar_app");
  assert.equal(who.is_super, false, "a superuser would make this suite meaningless");

  await admin`DELETE FROM users WHERE id = ${U}`;
  await admin`INSERT INTO users (id, email, name) VALUES (${U}, 'da@example.test', 'Alice')`;
  // On the roster. Since the roster became a precondition in
  // app_is_room_member, a membership row on its own reaches nothing, and every
  // queue test here would fail for that reason rather than the one it tests.
  await admin`INSERT INTO hangar_members (user_id) VALUES (${U}) ON CONFLICT DO NOTHING`;
  await admin`
    INSERT INTO rooms (id, slug, name, created_by) VALUES
      (${R1}, 'dispatch-one', 'One', ${U}),
      (${R2}, 'dispatch-two', 'Two', ${U})
  `;
  await admin`
    INSERT INTO room_members (id, room_id, user_id, role) VALUES
      ('dm_1', ${R1}, ${U}, 'owner'),
      ('dm_2', ${R2}, ${U}, 'owner')
  `;
});

beforeEach(async () => {
  await admin`DELETE FROM dispatch_commands WHERE room_id IN (${R1}, ${R2})`;
});

after(async () => {
  if (admin) {
    await admin`DELETE FROM users WHERE id = ${U}`;
    await admin`DELETE FROM rooms WHERE id IN (${R1}, ${R2})`;
    await admin.end({ timeout: 5 });
  }
  if (app) await app.end({ timeout: 5 });
});

/** Queue a request the way the web app does: as the requesting member. */
async function request(id, roomId, ask, minutes = 10) {
  return asUser(U, (tx) =>
    tx`INSERT INTO dispatch_commands (id, room_id, requested_by, ask, expires_at)
       VALUES (${id}, ${roomId}, ${U}, ${ask}, now() + (${minutes} || ' minutes')::interval)`
  );
}

test("app_set_user refuses an empty identity", async () => {
  await assert.rejects(
    () => app.begin((tx) => tx`SELECT app_set_user('')`),
    /user id is required/i,
    "an empty identity would silently scope every policy to nobody"
  );
});

test("a member queues a request and the companion claims it", async () => {
  await request("d_1", R1, "fix the flaky test");
  const claimed = await app`SELECT * FROM app_claim_next_dispatch()`;
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].id, "d_1");
  assert.equal(claimed[0].room_id, R1);
  assert.equal(claimed[0].ask, "fix the flaky test");
});

test("the same request is never handed out twice", async () => {
  await request("d_2", R1, "one only");
  const first = await app`SELECT * FROM app_claim_next_dispatch()`;
  assert.equal(first.length, 1);
  const second = await app`SELECT * FROM app_claim_next_dispatch()`;
  assert.equal(second.length, 0, "a second companion must not get the same work");
});

test("requests are claimed oldest first", async () => {
  await request("d_old", R1, "older");
  await admin`UPDATE dispatch_commands SET created_at = now() - interval '5 minutes' WHERE id = 'd_old'`;
  await request("d_new", R2, "newer");
  const [claimed] = await app`SELECT * FROM app_claim_next_dispatch()`;
  assert.equal(claimed.id, "d_old");
});

test("an expired request is never claimed", async () => {
  await request("d_stale", R1, "forgotten");
  await admin`UPDATE dispatch_commands SET expires_at = now() - interval '1 minute' WHERE id = 'd_stale'`;
  const claimed = await app`SELECT * FROM app_claim_next_dispatch()`;
  assert.equal(claimed.length, 0, "a queue with no expiry hands week-old work to whoever connects next");
});

test("one live request per room, enforced by the index not by convention", async () => {
  await request("d_a", R1, "first");
  await assert.rejects(
    () => request("d_b", R1, "second"),
    /duplicate key|unique/i,
    "a second live dispatch in the same room must be impossible"
  );
});

test("a finished room accepts a new request", async () => {
  await request("d_c", R1, "first");
  await app`SELECT app_finish_dispatch('d_c', 'done')`;
  await request("d_d", R1, "second");
  const rows = await asUser(U, (tx) => tx`SELECT id FROM dispatch_commands WHERE room_id = ${R1}`);
  assert.equal(rows.length, 2);
});

test("completing twice is a no-op, not a second completion", async () => {
  await request("d_e", R1, "work");
  await app`SELECT * FROM app_claim_next_dispatch()`;
  const [first] = await app`SELECT app_finish_dispatch('d_e', 'done') AS ok`;
  assert.equal(first.ok, true);
  const [second] = await app`SELECT app_finish_dispatch('d_e', 'done') AS ok`;
  assert.equal(second.ok, false, "a retrying companion must not post a second report");
});

test("a non-terminal status is refused", async () => {
  await request("d_f", R1, "work");
  await assert.rejects(
    () => app`SELECT app_finish_dispatch('d_f', 'running')`,
    /not a terminal status/i
  );
});

// The two below assert a specific WITH CHECK clause, not the roster gate. The
// fixture user is on the roster, so a pass here means the clause did the work.
test("a member cannot queue a request attributed to someone else", async () => {
  await assert.rejects(
    () =>
      asUser(U, (tx) =>
        tx`INSERT INTO dispatch_commands (id, room_id, requested_by, ask, expires_at)
           VALUES ('d_forge', ${R1}, 'u_someone_else', 'not mine', now() + interval '10 minutes')`
      ),
    /row-level security/i
  );
});

test("a member cannot queue a request already marked running", async () => {
  await assert.rejects(
    () =>
      asUser(U, (tx) =>
        tx`INSERT INTO dispatch_commands (id, room_id, requested_by, ask, status, expires_at)
           VALUES ('d_sneak', ${R1}, ${U}, 'skip the queue', 'running', now() + interval '10 minutes')`
      ),
    /row-level security/i,
    "status is pinned to pending at INSERT so nobody can bypass claiming"
  );
});

// --- the reaper ----------------------------------------------------------

test("a claim that never finished is swept, and the room frees up", async () => {
  await request("d_wedge", R1, "companion will die here");
  const claimed = await app`SELECT * FROM app_claim_next_dispatch()`;
  assert.equal(claimed.length, 1);

  // The room is wedged: the partial unique index counts a claimed row as live.
  await assert.rejects(
    () => request("d_blocked", R1, "cannot get in"),
    /duplicate key|unique/i,
    "a live claim blocks the room, which is the whole reason a reaper is needed"
  );

  // Age the claim past the window.
  await admin`UPDATE dispatch_commands SET claimed_at = now() - interval '2 hours' WHERE id = 'd_wedge'`;

  const [swept] = await app`SELECT app_expire_stale_dispatches(30) AS n`;
  assert.equal(swept.n, 1);

  const [row] = await admin`SELECT status FROM dispatch_commands WHERE id = 'd_wedge'`;
  assert.equal(row.status, "expired");

  await request("d_after", R1, "room is free again");
});

test("the reaper leaves a live claim alone", async () => {
  await request("d_live", R1, "still working");
  await app`SELECT * FROM app_claim_next_dispatch()`;

  const [swept] = await app`SELECT app_expire_stale_dispatches(30) AS n`;
  assert.equal(swept.n, 0, "a session that started a minute ago must not be swept");

  const [row] = await admin`SELECT status FROM dispatch_commands WHERE id = 'd_live'`;
  assert.equal(row.status, "claimed");
});

test("the reaper never touches a pending row", async () => {
  await request("d_pending", R1, "not claimed yet");
  await admin`UPDATE dispatch_commands SET created_at = now() - interval '2 hours' WHERE id = 'd_pending'`;

  await app`SELECT app_expire_stale_dispatches(1) AS n`;

  const [row] = await admin`SELECT status FROM dispatch_commands WHERE id = 'd_pending'`;
  assert.equal(row.status, "pending", "pending rows are governed by expires_at, not by the reaper");
});
