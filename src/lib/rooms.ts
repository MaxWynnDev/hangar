// Room and roster queries.
//
// Every function here takes the caller's user id and goes through `withUser`,
// so row level security decides what comes back. None of them filter by
// membership in their WHERE clause, and that is deliberate: duplicating the
// access rule in application code creates a second place for it to drift. The
// policies are the rule. A query that returns nothing here is the access model
// answering, not a bug to route around.

import { withUser } from "../db/with-user.js";
import { newId } from "./ids.js";

export interface Room {
  id: string;
  slug: string;
  name: string;
  topic: string | null;
  createdBy: string | null;
  createdAt: string;
  archivedAt: string | null;
  isSession: boolean;
  unread: number;
}

export async function listRooms(userId: string): Promise<Room[]> {
  return withUser(userId, async (tx) => {
    const rows = await tx<
      {
        id: string;
        slug: string;
        name: string;
        topic: string | null;
        created_by: string | null;
        created_at: string;
        archived_at: string | null;
        is_session: boolean;
        unread: string;
      }[]
    >`
      SELECT r.id, r.slug, r.name, r.topic, r.created_by, r.created_at, r.archived_at,
             (s.room_id IS NOT NULL) AS is_session,
             (
               SELECT count(*)
               FROM room_posts p
               WHERE p.room_id = r.id
                 AND p.deleted_at IS NULL
                 AND p.created_at > COALESCE(m.last_read_at, '-infinity'::timestamptz)
             ) AS unread
      FROM rooms r
      LEFT JOIN hangar_sessions s ON s.room_id = r.id
      LEFT JOIN room_members m
        ON m.room_id = r.id AND m.user_id = app_current_user_id()
      WHERE r.archived_at IS NULL
      ORDER BY r.created_at DESC
    `;
    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      topic: r.topic,
      createdBy: r.created_by,
      createdAt: r.created_at,
      archivedAt: r.archived_at,
      isSession: r.is_session,
      unread: Number(r.unread),
    }));
  });
}

/**
 * Create a room and put the creator in it, atomically.
 *
 * Both statements are in one transaction because a room whose creator is not a
 * member is unreachable: the SELECT policy needs a membership row, so a failure
 * between the two would leave a room nobody, including its creator, can open.
 */
export async function createRoom(
  userId: string,
  input: { slug: string; name: string; topic?: string }
): Promise<Room> {
  const roomId = newId("room");
  return withUser(userId, async (tx) => {
    await tx`
      INSERT INTO rooms (id, slug, name, topic, created_by)
      VALUES (${roomId}, ${input.slug}, ${input.name}, ${input.topic ?? null}, ${userId})
    `;
    await tx`
      INSERT INTO room_members (id, room_id, user_id, role, added_by)
      VALUES (${newId("mem")}, ${roomId}, ${userId}, 'owner', ${userId})
    `;
    return {
      id: roomId,
      slug: input.slug,
      name: input.name,
      topic: input.topic ?? null,
      createdBy: userId,
      createdAt: new Date().toISOString(),
      archivedAt: null,
      isSession: false,
      unread: 0,
    };
  });
}

/** Turn a room into a shared session. Refused by the database if it has posts. */
export async function openSession(userId: string, roomId: string): Promise<void> {
  await withUser(userId, (tx) => tx`SELECT app_open_session(${roomId})`);
}

export async function markRead(userId: string, roomId: string): Promise<void> {
  await withUser(userId, (tx) => tx`SELECT app_mark_room_read(${roomId})`);
}

export interface RosterEntry {
  userId: string;
  name: string | null;
  email: string;
}

export async function listRoster(userId: string): Promise<RosterEntry[]> {
  return withUser(userId, async (tx) => {
    const rows = await tx<{ user_id: string; name: string | null; email: string }[]>`
      SELECT h.user_id, u.name, u.email
      FROM hangar_members h
      JOIN users u ON u.id = h.user_id
      ORDER BY u.name NULLS LAST, u.email
    `;
    return rows.map((r) => ({ userId: r.user_id, name: r.name, email: r.email }));
  });
}
