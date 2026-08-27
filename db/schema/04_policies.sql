-- Hangar: row level security.
--
-- Every table here is ENABLE + FORCE. FORCE matters: without it the table owner
-- bypasses its own policies, and "the owner" is whoever the migration ran as,
-- which on a small deployment is the same role the app connects with.
--
-- The application connects as `hangar_app`, which is NOT the owner and holds
-- no BYPASSRLS. See 04_grants.sql.
--
-- Policies are dropped before creation so the file is re-runnable.

-- ---------------------------------------------------------------------------
-- rooms
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS rooms_member_select ON rooms;
CREATE POLICY rooms_member_select ON rooms
  AS PERMISSIVE FOR SELECT
  USING (app_is_room_member(id));

-- Roster required. Without it an off-roster user could create a room, become
-- its owner, add themselves to it, and use that membership to post and queue a
-- dispatch, which runs code on the companion's machine.
DROP POLICY IF EXISTS rooms_creator_insert ON rooms;
CREATE POLICY rooms_creator_insert ON rooms
  AS PERMISSIVE FOR INSERT
  WITH CHECK (
    app_is_hangar_member()
    AND created_by = app_current_user_id()
  );

-- Admin, not member. Renaming a room, changing its slug and archiving it are
-- all reachable through UPDATE, and no plain member needs any of them.
DROP POLICY IF EXISTS rooms_admin_update ON rooms;
CREATE POLICY rooms_admin_update ON rooms
  AS PERMISSIVE FOR UPDATE
  USING (app_can_admin_room(id))
  WITH CHECK (app_can_admin_room(id));

ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE rooms FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- room_members
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS room_members_select ON room_members;
CREATE POLICY room_members_select ON room_members
  AS PERMISSIVE FOR SELECT
  USING (app_is_room_member(room_id));

DROP POLICY IF EXISTS room_members_admin ON room_members;
CREATE POLICY room_members_admin ON room_members
  AS PERMISSIVE FOR ALL
  USING (app_can_admin_room(room_id))
  WITH CHECK (app_can_admin_room(room_id));

ALTER TABLE room_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_members FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- room_posts
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS room_posts_select ON room_posts;
CREATE POLICY room_posts_select ON room_posts
  AS PERMISSIVE FOR SELECT
  USING (app_is_room_member(room_id));

-- Authorship is bound at INSERT, not just UPDATE. Without the binding any
-- member could write a post attributed to another user, or forge an agent
-- post. The app role therefore inserts ONLY user posts as itself; agent and
-- system posts arrive exclusively through app_post_agent_message().
DROP POLICY IF EXISTS room_posts_insert ON room_posts;
CREATE POLICY room_posts_insert ON room_posts
  AS PERMISSIVE FOR INSERT
  WITH CHECK (
    app_is_room_member(room_id)
    AND author_kind = 'user'
    AND author_user_id = app_current_user_id()
  );

DROP POLICY IF EXISTS room_posts_author_update ON room_posts;
CREATE POLICY room_posts_author_update ON room_posts
  AS PERMISSIVE FOR UPDATE
  USING (
    app_is_room_member(room_id)
    AND author_user_id = app_current_user_id()
  )
  WITH CHECK (
    app_is_room_member(room_id)
    AND author_user_id = app_current_user_id()
  );

ALTER TABLE room_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_posts FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- room_post_reactions
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS room_post_reactions_select ON room_post_reactions;
CREATE POLICY room_post_reactions_select ON room_post_reactions
  AS PERMISSIVE FOR SELECT
  USING (app_is_room_member(room_id));

-- Both write policies bind user_id to the caller, so nobody reacts as, or
-- un-reacts for, a teammate.
DROP POLICY IF EXISTS room_post_reactions_own_insert ON room_post_reactions;
CREATE POLICY room_post_reactions_own_insert ON room_post_reactions
  AS PERMISSIVE FOR INSERT
  WITH CHECK (
    app_is_room_member(room_id)
    AND user_id = app_current_user_id()
  );

DROP POLICY IF EXISTS room_post_reactions_own_delete ON room_post_reactions;
CREATE POLICY room_post_reactions_own_delete ON room_post_reactions
  AS PERMISSIVE FOR DELETE
  USING (
    app_is_room_member(room_id)
    AND user_id = app_current_user_id()
  );

ALTER TABLE room_post_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_post_reactions FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- room_presence
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS room_presence_select ON room_presence;
CREATE POLICY room_presence_select ON room_presence
  AS PERMISSIVE FOR SELECT
  USING (app_is_room_member(room_id));

DROP POLICY IF EXISTS room_presence_own_write ON room_presence;
CREATE POLICY room_presence_own_write ON room_presence
  AS PERMISSIVE FOR ALL
  USING (
    app_is_room_member(room_id)
    AND user_id = app_current_user_id()
  )
  WITH CHECK (
    app_is_room_member(room_id)
    AND user_id = app_current_user_id()
  );

ALTER TABLE room_presence ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_presence FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- hangar_members and hangar_sessions
-- ---------------------------------------------------------------------------

-- The roster is visible to the roster. Writes go through the definer functions
-- only; there is no INSERT, UPDATE or DELETE policy here.
DROP POLICY IF EXISTS hangar_members_select ON hangar_members;
CREATE POLICY hangar_members_select ON hangar_members
  AS PERMISSIVE FOR SELECT
  USING (app_is_hangar_member());

ALTER TABLE hangar_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE hangar_members FORCE ROW LEVEL SECURITY;

-- SELECT is USING (true) on purpose. This table is read from INSIDE
-- app_is_room_member(), which is the SELECT policy of most tables here, so a
-- membership predicate on it would recurse. It holds no secret: it is a list of
-- room ids that are sessions, and every table it governs stays governed.
DROP POLICY IF EXISTS hangar_sessions_select ON hangar_sessions;
CREATE POLICY hangar_sessions_select ON hangar_sessions
  AS PERMISSIVE FOR SELECT
  USING (true);

ALTER TABLE hangar_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hangar_sessions FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- dispatch_commands and session_events
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS dispatch_commands_select ON dispatch_commands;
CREATE POLICY dispatch_commands_select ON dispatch_commands
  AS PERMISSIVE FOR SELECT
  USING (app_is_room_member(room_id));

-- Requesting a dispatch is bound to the caller. Claiming and completing are the
-- companion's job and run as a different role, not through this policy.
DROP POLICY IF EXISTS dispatch_commands_request ON dispatch_commands;
CREATE POLICY dispatch_commands_request ON dispatch_commands
  AS PERMISSIVE FOR INSERT
  WITH CHECK (
    app_is_room_member(room_id)
    AND requested_by = app_current_user_id()
    AND status = 'pending'
  );

ALTER TABLE dispatch_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch_commands FORCE ROW LEVEL SECURITY;

-- No INSERT policy. Console rows are written ONLY by app_post_session_event().
DROP POLICY IF EXISTS session_events_select ON session_events;
CREATE POLICY session_events_select ON session_events
  AS PERMISSIVE FOR SELECT
  USING (app_is_room_member(room_id));

ALTER TABLE session_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_events FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- room_attachments
-- ---------------------------------------------------------------------------

-- Participant, not member: this keys on arm 1 only. The upload route mints
-- storage credentials off a bare membership check, so widening it to the whole
-- roster would hand every member credential minting on every room.
DROP POLICY IF EXISTS room_attachments_select ON room_attachments;
CREATE POLICY room_attachments_select ON room_attachments
  AS PERMISSIVE FOR SELECT
  USING (app_is_room_participant(room_id));

DROP POLICY IF EXISTS room_attachments_insert ON room_attachments;
CREATE POLICY room_attachments_insert ON room_attachments
  AS PERMISSIVE FOR INSERT
  WITH CHECK (
    app_is_room_participant(room_id)
    AND uploaded_by = app_current_user_id()
  );

DROP POLICY IF EXISTS room_attachments_own_update ON room_attachments;
CREATE POLICY room_attachments_own_update ON room_attachments
  AS PERMISSIVE FOR UPDATE
  USING (
    app_is_room_participant(room_id)
    AND uploaded_by = app_current_user_id()
  )
  WITH CHECK (
    app_is_room_participant(room_id)
    AND uploaded_by = app_current_user_id()
  );

ALTER TABLE room_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_attachments FORCE ROW LEVEL SECURITY;
