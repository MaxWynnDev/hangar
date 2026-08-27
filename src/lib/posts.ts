// Messages, reactions and the live console.
//
// As in rooms.ts, nothing here filters by membership. The policies do that, and
// duplicating the rule in a WHERE clause creates a second place for it to drift
// out of step with the schema.

import { withUser } from "../db/with-user.js";
import { newId } from "./ids.js";
import { isReaction } from "./reactions.js";

export interface Post {
  id: string;
  roomId: string;
  authorKind: "user" | "agent" | "system";
  authorUserId: string | null;
  authorAgentId: string | null;
  authorLabel: string | null;
  body: string | null;
  parentPostId: string | null;
  createdAt: string;
  editedAt: string | null;
  reactions: { emoji: string; count: number; mine: boolean }[];
}

interface PostRow {
  id: string;
  room_id: string;
  author_kind: Post["authorKind"];
  author_user_id: string | null;
  author_agent_id: string | null;
  author_label: string | null;
  body: string | null;
  parent_post_id: string | null;
  created_at: string;
  edited_at: string | null;
  reactions: { emoji: string; count: number; mine: boolean }[] | null;
}

const SELECT_POSTS = (limit: number) => limit;

export async function listPosts(
  userId: string,
  roomId: string,
  opts: { limit?: number; before?: string } = {}
): Promise<Post[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
  return withUser(userId, async (tx) => {
    const rows = await tx<PostRow[]>`
      SELECT p.id, p.room_id, p.author_kind, p.author_user_id, p.author_agent_id,
             COALESCE(p.author_label, u.name, u.email) AS author_label,
             p.body, p.parent_post_id, p.created_at, p.edited_at,
             (
               SELECT coalesce(jsonb_agg(x), '[]'::jsonb)
               FROM (
                 SELECT rr.emoji,
                        count(*)::int AS count,
                        bool_or(rr.user_id = app_current_user_id()) AS mine
                 FROM room_post_reactions rr
                 WHERE rr.post_id = p.id
                 GROUP BY rr.emoji
                 ORDER BY rr.emoji
               ) x
             ) AS reactions
      FROM room_posts p
      LEFT JOIN users u ON u.id = p.author_user_id
      WHERE p.room_id = ${roomId}
        AND p.deleted_at IS NULL
        ${opts.before ? tx`AND p.created_at < (SELECT created_at FROM room_posts WHERE id = ${opts.before})` : tx``}
      ORDER BY p.created_at DESC
      LIMIT ${SELECT_POSTS(limit)}
    `;
    // Newest-first for the LIMIT, oldest-first for reading.
    return rows.reverse().map((r) => ({
      id: r.id,
      roomId: r.room_id,
      authorKind: r.author_kind,
      authorUserId: r.author_user_id,
      authorAgentId: r.author_agent_id,
      authorLabel: r.author_label,
      body: r.body,
      parentPostId: r.parent_post_id,
      createdAt: r.created_at,
      editedAt: r.edited_at,
      reactions: r.reactions ?? [],
    }));
  });
}

export async function createPost(
  userId: string,
  roomId: string,
  body: string,
  parentPostId?: string
): Promise<string> {
  const id = newId("post");
  await withUser(userId, async (tx) => {
    // author_kind and author_user_id are pinned by the INSERT policy, so
    // passing anything else here fails rather than being silently corrected.
    await tx`
      INSERT INTO room_posts (id, room_id, author_kind, author_user_id, body, parent_post_id)
      VALUES (${id}, ${roomId}, 'user', ${userId}, ${body}, ${parentPostId ?? null})
    `;
  });
  return id;
}

/**
 * Toggle a reaction.
 *
 * A single INSERT or DELETE arbitrated by the unique index, never a
 * read-modify-write on a shared column that two people clicking at once can
 * lose.
 */
export async function toggleReaction(
  userId: string,
  roomId: string,
  postId: string,
  emoji: string
): Promise<{ added: boolean }> {
  if (!isReaction(emoji)) {
    throw new Error(`not an allowed reaction: ${emoji}`);
  }
  return withUser(userId, async (tx) => {
    const deleted = await tx`
      DELETE FROM room_post_reactions
      WHERE post_id = ${postId} AND user_id = ${userId} AND emoji = ${emoji}
      RETURNING id
    `;
    if (deleted.length > 0) return { added: false };

    await tx`
      INSERT INTO room_post_reactions (id, room_id, post_id, user_id, emoji)
      VALUES (${newId("rx")}, ${roomId}, ${postId}, ${userId}, ${emoji})
      ON CONFLICT (post_id, user_id, emoji) DO NOTHING
    `;
    return { added: true };
  });
}

export interface SessionEvent {
  id: string;
  /** Room-wide cursor. Pass the highest one back as `since`. */
  roomSeq: string;
  seq: number;
  kind: string;
  label: string | null;
  body: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export async function listSessionEvents(
  userId: string,
  roomId: string,
  sinceSeq = 0
): Promise<SessionEvent[]> {
  return withUser(userId, async (tx) => {
    const rows = await tx<
      {
        id: string;
        room_seq: string;
        seq: number;
        kind: string;
        label: string | null;
        body: string | null;
        metadata: Record<string, unknown> | null;
        created_at: string;
      }[]
    >`
      SELECT id, room_seq, seq, kind, label, body, metadata, created_at
      FROM session_events
      WHERE room_id = ${roomId} AND room_seq > ${sinceSeq}
      ORDER BY room_seq
      LIMIT 500
    `;
    return rows.map((r) => ({
      id: r.id,
      roomSeq: String(r.room_seq),
      seq: r.seq,
      kind: r.kind,
      label: r.label,
      body: r.body,
      metadata: r.metadata,
      createdAt: r.created_at,
    }));
  });
}

export async function heartbeat(
  userId: string,
  roomId: string,
  typing: boolean
): Promise<void> {
  await withUser(userId, async (tx) => {
    await tx`
      INSERT INTO room_presence (room_id, user_id, last_seen_at, typing_at)
      VALUES (${roomId}, ${userId}, now(), ${typing ? tx`now()` : null})
      ON CONFLICT (room_id, user_id) DO UPDATE
        SET last_seen_at = now(),
            typing_at = ${typing ? tx`now()` : tx`room_presence.typing_at`}
    `;
  });
}
