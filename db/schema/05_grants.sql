-- Hangar: the application role and what it may do.
--
-- The app connects as `hangar_app`. It is deliberately NOT the owner of these
-- tables and has no BYPASSRLS, because FORCE ROW LEVEL SECURITY still lets a
-- superuser or a BYPASSRLS role read everything. Running migrations as one role
-- and serving traffic as another is the whole point.
--
-- Grants are the second half of the access model. A policy can only narrow what
-- a grant already allows, so a missing REVOKE is as much a hole as a missing
-- policy. Note what is absent below:
--
--   * no DELETE on room_posts        conversation soft-deletes, it is history
--   * no DELETE on session_events    the console is evidence of what ran
--   * no INSERT on session_events    only app_post_session_event() writes
--   * no write at all on hangar_members / hangar_sessions
--                                    only the definer functions write those
--   * no UPDATE on dispatch_commands the companion claims and completes rows
--                                    as its own role, not as the web app

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hangar_app') THEN
    CREATE ROLE hangar_app NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO hangar_app;

-- Identity is read-only to the app; provisioning users is an operator action.
GRANT SELECT ON users TO hangar_app;

GRANT SELECT, INSERT, UPDATE ON rooms TO hangar_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON room_members TO hangar_app;
GRANT SELECT, INSERT, UPDATE ON room_posts TO hangar_app;
GRANT SELECT, INSERT, DELETE ON room_post_reactions TO hangar_app;
GRANT SELECT, INSERT, UPDATE ON room_presence TO hangar_app;
GRANT SELECT ON hangar_members TO hangar_app;
GRANT SELECT ON hangar_sessions TO hangar_app;
GRANT SELECT, INSERT ON dispatch_commands TO hangar_app;
GRANT SELECT ON session_events TO hangar_app;
GRANT SELECT, INSERT, UPDATE ON room_attachments TO hangar_app;

-- The definer functions were revoked from PUBLIC when they were created, so the
-- app needs them granted back explicitly. This list IS the app's write surface
-- for everything the policies deliberately refuse.
GRANT EXECUTE ON FUNCTION app_current_user_id() TO hangar_app;
GRANT EXECUTE ON FUNCTION app_is_room_participant(text) TO hangar_app;
GRANT EXECUTE ON FUNCTION app_is_room_member(text) TO hangar_app;
GRANT EXECUTE ON FUNCTION app_can_admin_room(text) TO hangar_app;
GRANT EXECUTE ON FUNCTION app_is_hangar_member() TO hangar_app;
GRANT EXECUTE ON FUNCTION app_mark_room_read(text) TO hangar_app;
GRANT EXECUTE ON FUNCTION app_post_agent_message(text, text, text, text, text, jsonb, text) TO hangar_app;
GRANT EXECUTE ON FUNCTION app_post_session_event(text, text, text, integer, text, text, text, jsonb) TO hangar_app;
GRANT EXECUTE ON FUNCTION app_open_session(text) TO hangar_app;
GRANT EXECUTE ON FUNCTION app_add_hangar_member(text) TO hangar_app;
GRANT EXECUTE ON FUNCTION app_remove_hangar_member(text) TO hangar_app;

-- Identity, and the companion path. The companion path functions bypass RLS by
-- design and are guarded only by the bearer token on their single HTTP route.
GRANT EXECUTE ON FUNCTION app_set_user(text) TO hangar_app;
GRANT EXECUTE ON FUNCTION app_claim_next_dispatch() TO hangar_app;
GRANT EXECUTE ON FUNCTION app_start_dispatch(text) TO hangar_app;
GRANT EXECUTE ON FUNCTION app_finish_dispatch(text, text) TO hangar_app;
GRANT EXECUTE ON FUNCTION app_dispatch_room(text) TO hangar_app;
GRANT EXECUTE ON FUNCTION app_expire_stale_dispatches(integer) TO hangar_app;
