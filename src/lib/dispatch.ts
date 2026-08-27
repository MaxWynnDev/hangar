// The companion path.
//
// THE ONLY FILE PERMITTED TO USE `withoutUserScope`.
//
// The companion is a process on a developer's machine. It has no user identity,
// so the member-scoped policies can never admit it, and the functions below are
// SECURITY DEFINER with no user check. Their guard is the bearer token checked
// by the single route that calls them.
//
// Everything here assumes its caller already authenticated the companion. If
// you find yourself calling one of these from a route a signed-in person can
// reach, stop: that would let anyone claim and complete other people's work.

import { withoutUserScope } from "../db/with-user.js";
import { newId } from "./ids.js";
import { scrubReport } from "./report-scrub.js";

/** How long a queued request stays claimable. */
export const DISPATCH_TTL_MINUTES = 15;

/**
 * How long a claimed request may sit before it is treated as abandoned.
 *
 * Longer than the session timeout in the companion (20 minutes), so a slow but
 * live session is never swept out from under itself.
 */
export const STALE_CLAIM_MINUTES = 30;

export interface ClaimedDispatch {
  id: string;
  roomId: string;
  ask: string;
}

/**
 * Take the oldest live request, if there is one.
 *
 * Returns null when the queue is empty, which is the common case: the companion
 * polls, and most polls find nothing.
 */
export async function claimNextDispatch(): Promise<ClaimedDispatch | null> {
  return withoutUserScope(async (tx) => {
    // Sweep first. A companion that died mid-session leaves its row claimed,
    // and the partial unique index counts that as live, so the room it was in
    // can never dispatch again. Doing it here means every poll unwedges.
    await tx`SELECT app_expire_stale_dispatches(${STALE_CLAIM_MINUTES})`;

    const rows = await tx<{ id: string; room_id: string; ask: string }[]>`
      SELECT * FROM app_claim_next_dispatch()
    `;
    const row = rows[0];
    if (!row) return null;
    return { id: row.id, roomId: row.room_id, ask: row.ask };
  });
}

export async function markDispatchRunning(id: string): Promise<boolean> {
  return withoutUserScope(async (tx) => {
    const rows = await tx<{ ok: boolean }[]>`SELECT app_start_dispatch(${id}) AS ok`;
    return rows[0]?.ok === true;
  });
}

export async function finishDispatch(
  id: string,
  status: "done" | "failed" | "expired"
): Promise<boolean> {
  return withoutUserScope(async (tx) => {
    const rows = await tx<{ ok: boolean }[]>`
      SELECT app_finish_dispatch(${id}, ${status}) AS ok
    `;
    return rows[0]?.ok === true;
  });
}

export type SessionEventKind =
  | "status"
  | "thinking"
  | "message"
  | "tool"
  | "exec"
  | "edit"
  | "plan"
  | "error";

export interface SessionEventInput {
  commandId: string;
  roomId: string;
  /** Monotonic per command. Re-posting the same seq is a no-op by design. */
  seq: number;
  kind: SessionEventKind;
  label?: string;
  body?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Append console rows.
 *
 * Idempotent on (command_id, seq), so a companion that retries after a dropped
 * connection replays its batch without duplicating the console.
 */
export async function postSessionEvents(events: SessionEventInput[]): Promise<void> {
  if (events.length === 0) return;
  await withoutUserScope(async (tx) => {
    for (const e of events) {
      await tx`
        SELECT app_post_session_event(
          ${newId("ev")}, ${e.commandId}, ${e.roomId}, ${e.seq}, ${e.kind},
          ${e.label ?? null}, ${e.body ?? null},
          ${e.metadata ? JSON.stringify(e.metadata) : null}::jsonb
        )
      `;
    }
  });
}

/**
 * Post the agent's reply into the room.
 *
 * Scrubbed first. The session reads a real environment and its reply is durable
 * and visible to more people than could read that environment. A hit means
 * something upstream handed it a credential it did not need, so the count is
 * returned rather than swallowed.
 */
export async function postAgentReply(
  roomId: string,
  body: string,
  agentId = "claude-code"
): Promise<{ postId: string; scrubbed: number }> {
  const { text, hits } = scrubReport(body);
  const postId = newId("post");

  await withoutUserScope(async (tx) => {
    await tx`
      SELECT app_post_agent_message(
        ${postId}, ${roomId}, ${agentId}, 'Claude', ${text}, NULL, NULL
      )
    `;
  });

  return { postId, scrubbed: hits.reduce((n, h) => n + h.count, 0) };
}

/**
 * The room a dispatch belongs to, according to the database.
 *
 * The companion routes use this instead of the room id in the request body.
 * A client-supplied room id that the server can derive itself is a
 * confused-deputy waiting to happen: it would let a companion with a bug, or a
 * stolen token, deliver an agent reply into a room that never asked for one.
 */
export async function dispatchRoom(id: string): Promise<string | null> {
  return withoutUserScope(async (tx) => {
    const rows = await tx<{ room_id: string | null }[]>`
      SELECT app_dispatch_room(${id}) AS room_id
    `;
    return rows[0]?.room_id ?? null;
  });
}
