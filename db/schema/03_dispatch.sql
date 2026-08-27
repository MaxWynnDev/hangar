-- Hangar: setting the caller, and the dispatch claim protocol.
--
-- Split out of 02_functions.sql when that file crossed the 400 line budget.
-- These run after it because app_claim_next_dispatch names dispatch_commands
-- and Postgres validates a function body against the catalog at CREATE time.

-- ---------------------------------------------------------------------------
-- Setting the caller
-- ---------------------------------------------------------------------------

-- Set the identity every policy keys on, for the current transaction only.
--
-- Transaction-local matters. set_config(..., true) is the function form of
-- SET LOCAL, so the value dies at COMMIT or ROLLBACK. Without a surrounding
-- transaction it would either not apply, or leak to whoever checks out this
-- pooled connection next, which through a transaction-mode pooler is a
-- cross-user data leak rather than a bug.
CREATE OR REPLACE FUNCTION app_set_user(p_user_id text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF p_user_id IS NULL OR p_user_id = '' THEN
    RAISE EXCEPTION 'app_set_user: a user id is required';
  END IF;
  PERFORM set_config('app.user_id', p_user_id, true);
END;
$fn$;

-- ---------------------------------------------------------------------------
-- The dispatch claim protocol
--
-- READ THIS BEFORE CHANGING ANYTHING BELOW.
--
-- These two functions deliberately do NOT check app.user_id. The companion is
-- a process on a developer's machine, not a room member, so there is no user
-- identity to key on and the member-scoped policies can never admit it.
--
-- Their only guard is the HTTP layer: the companion authenticates with a
-- bearer token to one allowlisted route, and that route is the only caller.
-- Reaching either of these from a user-facing path would let any signed-in
-- person claim and complete other people's dispatches.
--
-- The companion never receives database credentials. It holds a token and
-- talks to the app over HTTP, so a laptop compromise does not become a
-- database compromise.
-- ---------------------------------------------------------------------------

-- Atomically take the oldest live request. SKIP LOCKED is what makes two
-- companions safe: the second skips the row the first is taking rather than
-- blocking on it or handing out the same work twice.
CREATE OR REPLACE FUNCTION app_claim_next_dispatch()
RETURNS TABLE (id text, room_id text, ask text)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  UPDATE dispatch_commands
  SET status = 'claimed', claimed_at = now()
  WHERE dispatch_commands.id = (
    SELECT d.id
    FROM dispatch_commands d
    WHERE d.status = 'pending'
      AND d.expires_at > now()
    ORDER BY d.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING dispatch_commands.id, dispatch_commands.room_id, dispatch_commands.ask;
$fn$;

REVOKE ALL ON FUNCTION app_claim_next_dispatch() FROM PUBLIC;

-- Move a claimed request to a terminal state. Refuses to resurrect a finished
-- one, so a duplicate completion from a retrying companion is a no-op rather
-- than a second agent post.
CREATE OR REPLACE FUNCTION app_finish_dispatch(p_id text, p_status text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  updated integer;
BEGIN
  IF p_status NOT IN ('done', 'failed', 'expired') THEN
    RAISE EXCEPTION 'app_finish_dispatch: % is not a terminal status', p_status;
  END IF;

  UPDATE dispatch_commands
  SET status = p_status, finished_at = now()
  WHERE id = p_id
    AND status IN ('pending', 'claimed', 'running');

  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated > 0;
END;
$fn$;

REVOKE ALL ON FUNCTION app_finish_dispatch(text, text) FROM PUBLIC;

-- Mark a claimed request as actively running.
CREATE OR REPLACE FUNCTION app_start_dispatch(p_id text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  updated integer;
BEGIN
  UPDATE dispatch_commands
  SET status = 'running'
  WHERE id = p_id AND status = 'claimed';
  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated > 0;
END;
$fn$;

REVOKE ALL ON FUNCTION app_start_dispatch(text) FROM PUBLIC;

-- The room a request belongs to, so the companion routes never have to trust a
-- client-supplied room id.
--
-- Without this the finish route takes roomId from the request body, which means
-- whoever holds the companion token can post an agent message into any room,
-- with no matching dispatch at all. The token holder is already trusted to post
-- as the agent, so this is not a privilege boundary; it is blast radius. A
-- companion with a bug should not be able to deliver a reply to the wrong room.
CREATE OR REPLACE FUNCTION app_dispatch_room(p_id text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT room_id FROM dispatch_commands WHERE id = p_id;
$fn$;

REVOKE ALL ON FUNCTION app_dispatch_room(text) FROM PUBLIC;

-- Free a request whose companion never came back.
--
-- A companion that dies between claiming and finishing leaves the row in
-- 'claimed' or 'running' forever. The partial unique index counts those as
-- live, so that room can never queue another dispatch, and nothing in the UI
-- explains why. expires_at does not help: it is only consulted when claiming,
-- and the row is already claimed.
--
-- Called on every poll from the claim path, so a wedged room frees itself
-- within the window rather than needing an operator.
CREATE OR REPLACE FUNCTION app_expire_stale_dispatches(p_minutes integer DEFAULT 30)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  swept integer;
BEGIN
  UPDATE dispatch_commands
  SET status = 'expired', finished_at = now()
  WHERE status IN ('claimed', 'running')
    AND claimed_at IS NOT NULL
    AND claimed_at < now() - make_interval(mins => p_minutes);

  GET DIAGNOSTICS swept = ROW_COUNT;
  RETURN swept;
END;
$fn$;

REVOKE ALL ON FUNCTION app_expire_stale_dispatches(integer) FROM PUBLIC;
