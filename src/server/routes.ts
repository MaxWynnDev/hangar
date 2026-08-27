// The API.
//
// Every handler that touches conversation takes the session's user id and goes
// through the lib layer, which goes through `withUser`. No handler filters by
// membership itself: the policies do that, and a second copy of the rule in a
// route is a second place for it to drift.

import type { IncomingMessage, ServerResponse } from "node:http";

import { readSession, issueCookie, clearCookie } from "./auth.js";
import { HttpError, boundedInt, json, noContent, readJson, requireSlug, requireString } from "./respond.js";
import { rateLimit, LIMITS } from "./ratelimit.js";
import { listRooms, createRoom, openSession, markRead, listRoster } from "../lib/rooms.js";
import { listPosts, createPost, toggleReaction, listSessionEvents, heartbeat } from "../lib/posts.js";
import { mentionsAgent, extractAsk } from "../lib/mentions.js";
import { DISPATCH_TTL_MINUTES } from "../lib/dispatch.js";
import { withUser } from "../db/with-user.js";
import { newId } from "../lib/ids.js";

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  userId: string;
}

function limitOr429(res: ServerResponse, key: string, spec: { limit: number; windowMs: number }): boolean {
  const r = rateLimit(key, spec.limit, spec.windowMs);
  if (r.ok) return true;
  json(res, 429, { error: "too many requests" }, { "retry-after": String(r.retryAfterSeconds) });
  return false;
}

// --- session ---------------------------------------------------------------

/**
 * Sign in as an existing user.
 *
 * Hangar ships no identity provider on purpose. This maps an email that is
 * already in `users` to a signed cookie. Replace it with OIDC by replacing this
 * handler; nothing downstream knows how the session was established.
 *
 * There is no password because there is no credential to check. That is only
 * safe behind something that already authenticates, so the server refuses to
 * start with this enabled unless HANGAR_TRUSTED_LOGIN is set deliberately.
 */
export async function login(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (process.env.HANGAR_TRUSTED_LOGIN !== "true") {
    throw new HttpError(
      403,
      "email login is disabled. Set HANGAR_TRUSTED_LOGIN=true only behind an authenticating proxy."
    );
  }

  const body = await readJson<{ email?: unknown }>(req);
  const email = requireString(body.email, "email", { max: 320 }).toLowerCase();

  if (!limitOr429(res, `login:${email}`, LIMITS.login)) return;

  // Look the user up without a session, which is the one read that cannot be
  // user-scoped. `users` is readable by the app role and holds no conversation.
  const { sql } = await import("../db/client.js");
  const rows = await sql<{ id: string }[]>`SELECT id FROM users WHERE lower(email) = ${email}`;
  const user = rows[0];

  // Same response either way. Telling a stranger which addresses exist turns
  // this into a roster oracle.
  if (!user) {
    json(res, 200, { ok: true });
    return;
  }

  json(res, 200, { ok: true }, { "set-cookie": issueCookie(user.id) });
}

export function logout(_req: IncomingMessage, res: ServerResponse): void {
  json(res, 200, { ok: true }, { "set-cookie": clearCookie() });
}

export function requireSession(req: IncomingMessage): string {
  const session = readSession(req.headers.cookie);
  if (!session) throw new HttpError(401, "not signed in");
  return session.userId;
}

// --- rooms -----------------------------------------------------------------

export async function getRooms(ctx: Ctx): Promise<void> {
  if (!limitOr429(ctx.res, `general:${ctx.userId}`, LIMITS.general)) return;
  json(ctx.res, 200, { rooms: await listRooms(ctx.userId) });
}

export async function postRoom(ctx: Ctx): Promise<void> {
  if (!limitOr429(ctx.res, `general:${ctx.userId}`, LIMITS.general)) return;
  const body = await readJson<{ slug?: unknown; name?: unknown; topic?: unknown; session?: unknown }>(ctx.req);
  const slug = requireSlug(body.slug, "slug");
  const name = requireString(body.name, "name", { max: 120 });
  const topic = body.topic === undefined || body.topic === null ? undefined : requireString(body.topic, "topic", { max: 400 });

  const room = await createRoom(ctx.userId, { slug, name, topic });

  // Opening it as a session shares it with the whole roster. Only possible now,
  // while it has no posts, which is what stops a private room being converted
  // later and republishing its history.
  if (body.session === true) {
    await openSession(ctx.userId, room.id);
    room.isSession = true;
  }

  json(ctx.res, 201, { room });
}

export async function getRoster(ctx: Ctx): Promise<void> {
  if (!limitOr429(ctx.res, `general:${ctx.userId}`, LIMITS.general)) return;
  json(ctx.res, 200, { roster: await listRoster(ctx.userId) });
}

// --- posts -----------------------------------------------------------------

export async function getPosts(ctx: Ctx, roomId: string): Promise<void> {
  if (!limitOr429(ctx.res, `general:${ctx.userId}`, LIMITS.general)) return;
  const before = ctx.url.searchParams.get("before") ?? undefined;
  const limit = boundedInt(ctx.url.searchParams.get("limit"), { fallback: 100, min: 1, max: 200 });
  json(ctx.res, 200, { posts: await listPosts(ctx.userId, roomId, { before, limit }) });
}

export async function postMessage(ctx: Ctx, roomId: string): Promise<void> {
  if (!limitOr429(ctx.res, `post:${ctx.userId}`, LIMITS.post)) return;

  const body = await readJson<{ body?: unknown; parentPostId?: unknown }>(ctx.req);
  const text = requireString(body.body, "body", { max: 8000 });
  const parent = body.parentPostId === undefined ? undefined : requireString(body.parentPostId, "parentPostId", { max: 64 });

  const postId = await createPost(ctx.userId, roomId, text, parent);

  let dispatched: string | null = null;

  if (mentionsAgent(text)) {
    if (!limitOr429(ctx.res, `dispatch:${ctx.userId}`, LIMITS.dispatch)) return;

    const ask = extractAsk(text);
    if (ask.length > 0) {
      const commandId = newId("disp");
      try {
        await withUser(ctx.userId, async (tx) => {
          await tx`
            INSERT INTO dispatch_commands (id, room_id, requested_by, ask, expires_at)
            VALUES (${commandId}, ${roomId}, ${ctx.userId}, ${ask},
                    now() + (${DISPATCH_TTL_MINUTES} || ' minutes')::interval)
          `;
        });
        dispatched = commandId;
      } catch (err) {
        // The partial unique index refuses a second live dispatch per room.
        // That is the intended answer, not a server error: the message is
        // already posted, and the room can see a session is running.
        if (String(err).includes("dispatch_commands_one_live_per_room")) {
          dispatched = null;
        } else {
          throw err;
        }
      }
    }
  }

  json(ctx.res, 201, { postId, dispatched });
}

export async function postReaction(ctx: Ctx, roomId: string, postId: string): Promise<void> {
  if (!limitOr429(ctx.res, `general:${ctx.userId}`, LIMITS.general)) return;
  const body = await readJson<{ emoji?: unknown }>(ctx.req);
  const emoji = requireString(body.emoji, "emoji", { max: 32 });
  try {
    json(ctx.res, 200, await toggleReaction(ctx.userId, roomId, postId, emoji));
  } catch (err) {
    if (String(err).includes("not an allowed reaction")) {
      throw new HttpError(400, "not an allowed reaction");
    }
    throw err;
  }
}

export async function postRead(ctx: Ctx, roomId: string): Promise<void> {
  if (!limitOr429(ctx.res, `general:${ctx.userId}`, LIMITS.general)) return;
  await markRead(ctx.userId, roomId);
  noContent(ctx.res);
}

export async function postHeartbeat(ctx: Ctx, roomId: string): Promise<void> {
  const body = await readJson<{ typing?: unknown }>(ctx.req);
  await heartbeat(ctx.userId, roomId, body.typing === true);
  noContent(ctx.res);
}

export async function getEvents(ctx: Ctx, roomId: string): Promise<void> {
  if (!limitOr429(ctx.res, `general:${ctx.userId}`, LIMITS.general)) return;
  const since = boundedInt(ctx.url.searchParams.get("since"), {
    fallback: 0,
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
  });
  json(ctx.res, 200, { events: await listSessionEvents(ctx.userId, roomId, since) });
}
