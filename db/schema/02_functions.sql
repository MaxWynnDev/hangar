-- Hangar: the functions row level security calls.
--
-- WHY SECURITY DEFINER, and why it is not a shortcut.
--
-- A membership test written inline as a subquery on room_members would, inside
-- room_members' OWN policy, re-enter that policy and recurse. Running the
-- lookup as the function owner bypasses RLS on the lookup only, and breaks the
-- cycle. `search_path` is pinned on every one of them so a body can never be
-- redirected at a shadowed table.
--
-- These must be created AFTER 01_tables.sql. Postgres validates a function body
-- against the catalog at CREATE time, so defining them first fails on a fresh
-- database with "relation room_members does not exist".
--
-- Every caller must run inside a transaction that has set `app.user_id`.
-- Without it these all evaluate false and queries return zero rows rather than
-- leaking, which is the correct direction to fail.

-- ---------------------------------------------------------------------------
-- Who is asking
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_current_user_id()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT NULLIF(current_setting('app.user_id', true), '');
$fn$;

-- ---------------------------------------------------------------------------
-- Access predicates
-- ---------------------------------------------------------------------------

-- Arm 1 only: holds a membership row for this room. Attachments key on this
-- rather than on app_is_room_member, because the attachment route mints upload
-- credentials off a bare membership check, and widening it to the whole roster
-- would hand every member credential minting on every room.
CREATE OR REPLACE FUNCTION app_is_room_participant(p_room_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM hangar_members
    WHERE user_id = NULLIF(current_setting('app.user_id', true), '')
  ) AND EXISTS (
    SELECT 1 FROM room_members
    WHERE room_id = p_room_id
      AND user_id = NULLIF(current_setting('app.user_id', true), '')
  );
$fn$;

REVOKE ALL ON FUNCTION app_is_room_participant(text) FROM PUBLIC;

-- The predicate almost every policy uses. TWO arms, and you need both in mind:
--
--   1. the caller holds a room_members row for this room. This is what governs
--      private channels.
--   2. the room is a SESSION and the caller is on the Hangar roster. This is
--      what makes sessions shared: everyone on the roster reads every session.
--
-- A room with no hangar_sessions row is unreachable by arm 2, which is what
-- keeps private channels private.
CREATE OR REPLACE FUNCTION app_is_room_member(p_room_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  -- Roster membership is a PRECONDITION, not one of the arms.
  --
  -- It used to appear only inside the session arm, which meant a membership row
  -- alone was sufficient. That was a hole: nothing stopped an off-roster user
  -- creating a room (they pass rooms_creator_insert as their own creator),
  -- inserting their own membership row (app_can_admin_room admits a room's
  -- creator before any membership exists), and then posting and queueing a
  -- dispatch through this predicate's first arm. A dispatch is code execution
  -- on the companion's machine, so "on the roster" has to gate everything, not
  -- just the shared-session view.
  --
  -- Written as a precondition it also makes removal from the roster an actual
  -- revocation. Previously a removed person kept every room_members row and
  -- therefore kept posting and dispatching.
  SELECT EXISTS (
    SELECT 1 FROM hangar_members
    WHERE user_id = NULLIF(current_setting('app.user_id', true), '')
  ) AND (
    -- Then: either you hold a membership row for this room, or the room is a
    -- shared session and every roster member can reach it.
    EXISTS (
      SELECT 1 FROM room_members
      WHERE room_id = p_room_id
        AND user_id = NULLIF(current_setting('app.user_id', true), '')
    )
    OR EXISTS (SELECT 1 FROM hangar_sessions WHERE room_id = p_room_id)
  );
$fn$;

REVOKE ALL ON FUNCTION app_is_room_member(text) FROM PUBLIC;

-- Roster management for one room. The creator qualifies before any membership
-- row exists, which is what makes a brand new room bootstrappable.
CREATE OR REPLACE FUNCTION app_can_admin_room(p_room_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM hangar_members
    WHERE user_id = NULLIF(current_setting('app.user_id', true), '')
  ) AND (
  EXISTS (
    SELECT 1 FROM rooms r
    WHERE r.id = p_room_id
      AND r.created_by = NULLIF(current_setting('app.user_id', true), '')
  ) OR EXISTS (
    SELECT 1 FROM room_members m
    WHERE m.room_id = p_room_id
      AND m.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND m.role = 'owner'
  ));
$fn$;

REVOKE ALL ON FUNCTION app_can_admin_room(text) FROM PUBLIC;

-- On the Hangar roster at all.
CREATE OR REPLACE FUNCTION app_is_hangar_member()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM hangar_members
    WHERE user_id = NULLIF(current_setting('app.user_id', true), '')
  );
$fn$;

REVOKE ALL ON FUNCTION app_is_hangar_member() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Narrow writers
--
-- Each exists because the alternative was a policy that had to admit more than
-- the operation needed.
-- ---------------------------------------------------------------------------

-- Read receipts. A member must be able to bump their OWN last_read_at, but
-- room_members' only write policy is admin scoped, and a self-UPDATE policy
-- cannot stop the row's role column riding along, because a policy sees the
-- whole row. A definer function that touches exactly one column closes the
-- escalation surface instead.
CREATE OR REPLACE FUNCTION app_mark_room_read(p_room_id text)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  UPDATE room_members
  SET last_read_at = now()
  WHERE room_id = p_room_id
    AND user_id = NULLIF(current_setting('app.user_id', true), '');
$fn$;

REVOKE ALL ON FUNCTION app_mark_room_read(text) FROM PUBLIC;

-- The ONLY way an agent post enters a room.
--
-- room_posts' INSERT policy admits author_kind = 'user' bound to the caller, so
-- the application role cannot write an agent post at all, by construction. That
-- is deliberate: if the app role could write one, any bug that reaches an
-- INSERT could forge a message from the agent.
--
-- The guard here is the whole point. It refuses anything that is not an agent
-- post, so this cannot be used to forge a user post either.
CREATE OR REPLACE FUNCTION app_post_agent_message(
  p_id       text,
  p_room_id  text,
  p_agent_id text,
  p_label    text,
  p_body     text,
  p_metadata jsonb DEFAULT NULL,
  p_parent   text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF p_agent_id IS NULL OR p_agent_id = '' THEN
    RAISE EXCEPTION 'agent id is required';
  END IF;

  INSERT INTO room_posts (
    id, room_id, author_kind, author_user_id, author_agent_id,
    author_label, body, parent_post_id, metadata
  )
  VALUES (
    p_id, p_room_id, 'agent', NULL, p_agent_id,
    p_label, p_body, p_parent, p_metadata
  );

  RETURN p_id;
END;
$fn$;

REVOKE ALL ON FUNCTION app_post_agent_message(text, text, text, text, text, jsonb, text) FROM PUBLIC;

-- Console rows. Same reasoning: session_events has no INSERT policy, so this is
-- the only writer. The kind guard duplicates the CHECK constraint on purpose,
-- so a bad kind fails with a readable error rather than a constraint violation.
CREATE OR REPLACE FUNCTION app_post_session_event(
  p_id         text,
  p_command_id text,
  p_room_id    text,
  p_seq        integer,
  p_kind       text,
  p_label      text DEFAULT NULL,
  p_body       text DEFAULT NULL,
  p_metadata   jsonb DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF p_kind NOT IN ('status', 'thinking', 'message', 'tool', 'exec', 'edit', 'plan', 'error') THEN
    RAISE EXCEPTION 'unknown session event kind: %', p_kind;
  END IF;

  INSERT INTO session_events (id, command_id, room_id, seq, kind, label, body, metadata)
  VALUES (p_id, p_command_id, p_room_id, p_seq, p_kind, p_label, p_body, p_metadata)
  -- Re-posting a batch is idempotent: the companion may retry after a dropped
  -- connection and must not duplicate the console.
  ON CONFLICT (command_id, seq) DO NOTHING;
END;
$fn$;

REVOKE ALL ON FUNCTION app_post_session_event(text, text, text, integer, text, text, text, jsonb) FROM PUBLIC;

-- Turn a room into a session. Refuses a room that already has posts, which is
-- what makes "is a session" immutable in practice: you cannot retroactively
-- republish an existing private channel's history to the whole roster.
CREATE OR REPLACE FUNCTION app_open_session(p_room_id text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF NOT app_is_hangar_member() THEN
    RAISE EXCEPTION 'not on the roster';
  END IF;

  IF EXISTS (SELECT 1 FROM room_posts WHERE room_id = p_room_id) THEN
    RAISE EXCEPTION 'room already has posts; cannot convert it to a session';
  END IF;

  INSERT INTO hangar_sessions (room_id, opened_by)
  VALUES (p_room_id, NULLIF(current_setting('app.user_id', true), ''))
  ON CONFLICT (room_id) DO NOTHING;
END;
$fn$;

REVOKE ALL ON FUNCTION app_open_session(text) FROM PUBLIC;

-- Roster writers. Any member may add; the remover refuses to empty the roster,
-- because the last row out would lock the door behind it.
CREATE OR REPLACE FUNCTION app_add_hangar_member(p_user_id text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF NOT app_is_hangar_member() THEN
    RAISE EXCEPTION 'not on the roster';
  END IF;

  INSERT INTO hangar_members (user_id, added_by)
  VALUES (p_user_id, NULLIF(current_setting('app.user_id', true), ''))
  ON CONFLICT (user_id) DO NOTHING;
END;
$fn$;

REVOKE ALL ON FUNCTION app_add_hangar_member(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION app_remove_hangar_member(p_user_id text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF NOT app_is_hangar_member() THEN
    RAISE EXCEPTION 'not on the roster';
  END IF;

  IF (SELECT count(*) FROM hangar_members) <= 1 THEN
    RAISE EXCEPTION 'refusing to empty the roster';
  END IF;

  -- Drop their room memberships too. Removing only the roster row left the
  -- person with every room_members row they already had, and those rows are
  -- what the access predicate keys on, so removal did not remove anything.
  DELETE FROM room_members WHERE user_id = p_user_id;
  DELETE FROM hangar_members WHERE user_id = p_user_id;
END;
$fn$;

REVOKE ALL ON FUNCTION app_remove_hangar_member(text) FROM PUBLIC;
