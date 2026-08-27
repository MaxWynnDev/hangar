-- Hangar: tables.
--
-- Applied in filename order by scripts/apply-schema.mjs. Every statement is
-- re-runnable, so applying twice is a no-op rather than an error.
--
-- ADDING A COLUMN: put it in the CREATE TABLE for fresh installs AND add an
-- ALTER TABLE ... ADD COLUMN IF NOT EXISTS for installs that already have the
-- table. CREATE TABLE IF NOT EXISTS does nothing once the table exists, and CI
-- builds an empty database every run, so a missing ALTER passes every check
-- here and only breaks on someone else's upgrade.
--
-- Row level security lives in 04_policies.sql and the functions those policies
-- call live in 02_functions.sql and 03_dispatch.sql. The order matters: Postgres validates a
-- function body against the catalog at CREATE time, so a policy function that
-- names a table has to be created after the table exists.

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

-- Hangar owns its own users. Bring your own identity provider and write a row
-- here; `id` is whatever stable string that provider gives you.
CREATE TABLE IF NOT EXISTS users (
  id          text PRIMARY KEY,
  email       text NOT NULL,
  name        text,
  avatar_url  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_uidx ON users (lower(email));

-- ---------------------------------------------------------------------------
-- Rooms
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS rooms (
  id          text PRIMARY KEY,
  slug        text NOT NULL,
  name        text NOT NULL,
  topic       text,
  -- Nullable so deleting a user never blocks on a room they opened. The INSERT
  -- policy still requires a real value at creation time, which is what lets the
  -- creator add the first membership row.
  created_by  text REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- Rooms archive rather than delete. There is no DELETE policy.
  archived_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS rooms_slug_uidx ON rooms (slug);
CREATE INDEX IF NOT EXISTS rooms_active_idx ON rooms (created_at) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS room_members (
  id         text PRIMARY KEY,
  room_id    text NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  user_id    text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- `member` reads and posts. `owner` also manages the roster.
  role       text NOT NULL DEFAULT 'member',
  added_by   text REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Unread tracking. NULL means never opened. Written ONLY through
  -- app_mark_room_read(): this table's write policy is admin scoped, and a
  -- self-UPDATE policy could not keep a member's hands off their own role
  -- column, because a policy sees the whole row.
  last_read_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS room_members_room_user_uidx ON room_members (room_id, user_id);
CREATE INDEX IF NOT EXISTS room_members_user_idx ON room_members (user_id);

CREATE TABLE IF NOT EXISTS room_posts (
  id              text PRIMARY KEY,
  room_id         text NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  -- 'user' | 'agent' | 'system'. Immutable classification of the poster.
  author_kind     text NOT NULL,
  author_user_id  text REFERENCES users (id) ON DELETE SET NULL,
  -- Stable agent slug for agent posts, e.g. 'claude-code'. Never a user id.
  author_agent_id text,
  -- Display snapshot, so deleting a user does not erase who said what.
  author_label    text,
  body            text,
  parent_post_id  text REFERENCES room_posts (id) ON DELETE SET NULL,
  metadata        jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  edited_at       timestamptz,
  -- Soft delete. There is no DELETE policy or grant on this table.
  deleted_at      timestamptz,
  CONSTRAINT room_posts_author_kind_ck CHECK (author_kind IN ('user', 'agent', 'system'))
);

CREATE INDEX IF NOT EXISTS room_posts_room_created_idx ON room_posts (room_id, created_at DESC);
CREATE INDEX IF NOT EXISTS room_posts_parent_idx ON room_posts (parent_post_id);
-- Exists so a retention sweep can be added without a follow-up migration.
CREATE INDEX IF NOT EXISTS room_posts_retention_idx ON room_posts (created_at);

-- One row per (post, user, emoji). That is what makes the toggle a single
-- INSERT or DELETE arbitrated by the unique index, rather than a
-- read-modify-write on a shared jsonb column that two people can lose.
--
-- The only table here with a real DELETE policy, deliberately: conversation is
-- history and soft-deletes, a reaction is not. Un-reacting means it did not
-- happen.
CREATE TABLE IF NOT EXISTS room_post_reactions (
  id         text PRIMARY KEY,
  -- Denormalized so RLS keys on membership without joining room_posts.
  room_id    text NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  post_id    text NOT NULL REFERENCES room_posts (id) ON DELETE CASCADE,
  user_id    text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  emoji      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT room_post_reactions_emoji_len_ck CHECK (char_length(emoji) <= 32)
);

CREATE UNIQUE INDEX IF NOT EXISTS room_post_reactions_post_user_emoji_uidx
  ON room_post_reactions (post_id, user_id, emoji);
CREATE INDEX IF NOT EXISTS room_post_reactions_post_idx ON room_post_reactions (post_id);

-- Presence and typing, one row per (room, member).
--
-- BOTH SIGNALS ARE TIMESTAMPS, never booleans, and that is the whole design. A
-- boolean has to be turned off by somebody, and the client that would do it is
-- exactly the one that just closed its laptop or lost its network. Every chat
-- product that stores `is_typing boolean` eventually shows a ghost typing
-- forever. Readers compare now() against a window, so a client that vanishes
-- ages out on its own.
--
-- Bounded by (rooms x members) rather than by traffic, so it cannot grow with
-- conversation volume.
CREATE TABLE IF NOT EXISTS room_presence (
  room_id      text NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  user_id      text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  -- Null means not typing. A stale value ages out rather than sticking.
  typing_at    timestamptz,
  PRIMARY KEY (room_id, user_id)
);

CREATE INDEX IF NOT EXISTS room_presence_room_seen_idx ON room_presence (room_id, last_seen_at DESC);

-- ---------------------------------------------------------------------------
-- Membership of Hangar itself, and which rooms are sessions
-- ---------------------------------------------------------------------------

-- The roster. Access is NOT derived from "holds a room_members row somewhere":
-- session-first makes that circular, because there is no standing channel to
-- add a new teammate to.
--
-- NO ROLE COLUMN, deliberately. A role plus definer writers behind an owner
-- guard deadlocks: a fresh install creates zero owners, so the guard raises for
-- every caller forever and the add-member path ships dead. Writes go through
-- app_add_hangar_member / app_remove_hangar_member, and the remover refuses to
-- empty the roster, because the last row out locks the door behind it.
CREATE TABLE IF NOT EXISTS hangar_members (
  user_id    text PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  added_by   text REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Which rooms are SESSIONS. One row per room opened as one.
--
-- A table rather than a `rooms.kind` column because rooms grants UPDATE to the
-- application role and its admin policy pins no column, so a column would let
-- any room creator republish a private channel's entire history to the whole
-- roster with one UPDATE. There is NO write policy here. The only writer is
-- app_open_session(), which refuses a room that already has posts, so "is a
-- session" is immutable in practice rather than by convention.
CREATE TABLE IF NOT EXISTS hangar_sessions (
  room_id    text PRIMARY KEY REFERENCES rooms (id) ON DELETE CASCADE,
  opened_by  text REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Dispatch: the queue the companion process polls
-- ---------------------------------------------------------------------------

-- A request for an agent session. The web app never spawns anything; it writes
-- a row here, and a companion process running on a developer's own machine
-- claims it. That is what keeps code execution off the web host.
--
-- The claim protocol lives in 03_dispatch.sql. Those functions do not check
-- app.user_id, because the companion is a process on a laptop with no user
-- identity, so the member-scoped policies here can never admit it. Their guard
-- is the bearer token on the single route that calls them.
CREATE TABLE IF NOT EXISTS dispatch_commands (
  id           text PRIMARY KEY,
  room_id      text NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  requested_by text REFERENCES users (id) ON DELETE SET NULL,
  -- pending | claimed | running | done | failed | expired
  status       text NOT NULL DEFAULT 'pending',
  -- The verbatim human request. Never interpolated into a prompt as trusted
  -- text; see the dispatch prompt builder.
  ask          text NOT NULL,
  claimed_at   timestamptz,
  finished_at  timestamptz,
  -- Past this, an unclaimed row is dead. A queue with no expiry hands a
  -- forgotten request to whichever companion connects next week.
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispatch_commands_status_ck
    CHECK (status IN ('pending', 'claimed', 'running', 'done', 'failed', 'expired'))
);

CREATE INDEX IF NOT EXISTS dispatch_commands_room_created_idx
  ON dispatch_commands (room_id, created_at DESC);

-- One live dispatch per room. Parallel dispatch is a later relaxation, and a
-- partial unique index is the only place that rule cannot be forgotten.
CREATE UNIQUE INDEX IF NOT EXISTS dispatch_commands_one_live_per_room
  ON dispatch_commands (room_id)
  WHERE status IN ('pending', 'claimed', 'running');

-- The live console for a running dispatch.
--
-- Session activity lives HERE rather than in room_posts on purpose: one session
-- emits hundreds of thoughts, tool calls and edits, which would bury the human
-- conversation, ruin every unread badge, and put transcript volume in the table
-- whose retention window is about messages. The final report is still a room
-- post, so the durable record is unchanged. This is the disposable, live part.
CREATE TABLE IF NOT EXISTS session_events (
  id         text PRIMARY KEY,
  -- Monotonic across the table, which makes it a usable cursor once filtered by
  -- room. `seq` below cannot do that job: it restarts at zero for every
  -- dispatch, so a client holding seq=40 from one session never sees the next
  -- session's rows at all.
  room_seq   bigint GENERATED ALWAYS AS IDENTITY,
  command_id text NOT NULL REFERENCES dispatch_commands (id) ON DELETE CASCADE,
  -- Denormalized so the policy needs no join.
  room_id    text NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  -- Monotonic per command, derived from the companion's transcript read
  -- position. That is what makes re-posting a batch idempotent.
  seq        integer NOT NULL,
  kind       text NOT NULL,
  -- Tool name, file path, or status label. Never free-form prose.
  label      text,
  body       text,
  -- Presentation for one row: verb, object, tone, diff stats, tool status.
  -- jsonb rather than columns because the shape is presentational and still
  -- moving. EVERY key is optional and readers must treat it as absent-able.
  -- Nothing in an access decision reads this.
  metadata   jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- This list is duplicated in the writer guard and in the TypeScript reader.
  -- All three move together or the writer rejects a kind the reader accepts.
  CONSTRAINT session_events_kind_ck CHECK (
    kind IN ('status', 'thinking', 'message', 'tool', 'exec', 'edit', 'plan', 'error')
  )
);

-- Additive for anyone who applied this schema before room_seq existed.
-- CREATE TABLE IF NOT EXISTS above is a no-op once the table is there, so it
-- can never add a column to an existing install. CI starts from an empty
-- database every run and therefore cannot catch a missing ALTER; the only way
-- this stays correct is by adding one every time a column is added.
ALTER TABLE session_events
  ADD COLUMN IF NOT EXISTS room_seq bigint GENERATED ALWAYS AS IDENTITY;

CREATE UNIQUE INDEX IF NOT EXISTS session_events_command_seq_uidx
  ON session_events (command_id, seq);
CREATE INDEX IF NOT EXISTS session_events_room_cursor_idx
  ON session_events (room_id, room_seq);
CREATE INDEX IF NOT EXISTS session_events_room_created_idx
  ON session_events (room_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Attachments
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS room_attachments (
  id          text PRIMARY KEY,
  room_id     text NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  -- Null while an upload is in flight: the file is stored before the message
  -- carrying it exists, then adopted when the post is written.
  post_id     text REFERENCES room_posts (id) ON DELETE CASCADE,
  uploaded_by text REFERENCES users (id) ON DELETE SET NULL,
  url         text NOT NULL,
  pathname    text NOT NULL,
  name        text NOT NULL,
  mime        text NOT NULL,
  size_bytes  integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS room_attachments_post_idx ON room_attachments (post_id);
CREATE INDEX IF NOT EXISTS room_attachments_room_created_idx
  ON room_attachments (room_id, created_at DESC);
