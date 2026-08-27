// The companion API.
//
// THIS IS THE PRIVILEGED PATH. Everything here reaches functions that bypass
// row level security, because the companion has no user identity to scope to.
// The bearer token below is the entire guard. There is nothing behind it.
//
// Consequences worth stating plainly:
//
//   * Anyone holding HANGAR_COMPANION_TOKEN can read any queued request, post
//     as the agent into any room, and write to any room's console.
//   * Treat the token like a deploy key. Rotate it by changing the value and
//     restarting; there is no revocation list because there is one token.
//   * The companion never receives database credentials. It holds this token
//     and talks HTTP, so a stolen laptop is not a stolen database.
//
// The token is compared in constant time. A bearer token checked with === on a
// public endpoint leaks its prefix to anyone willing to time the response.

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { HttpError, json, noContent, readJson, requireString } from "./respond.js";
import {
  claimNextDispatch,
  markDispatchRunning,
  finishDispatch,
  postSessionEvents,
  postAgentReply,
  dispatchRoom,
  type SessionEventKind,
} from "../lib/dispatch.js";

const EVENT_KINDS = new Set<SessionEventKind>([
  "status",
  "thinking",
  "message",
  "tool",
  "exec",
  "edit",
  "plan",
  "error",
]);

function expectedToken(): string {
  const t = process.env.HANGAR_COMPANION_TOKEN;
  if (!t || t.length < 32) {
    throw new HttpError(
      503,
      "companion dispatch is not configured. Set HANGAR_COMPANION_TOKEN to at least 32 characters."
    );
  }
  return t;
}

/** Authenticate the companion, or throw. */
export function requireCompanion(req: IncomingMessage): void {
  const expected = expectedToken();
  const header = req.headers.authorization ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";

  const a = Buffer.from(presented);
  const b = Buffer.from(expected);

  // Length is compared first because timingSafeEqual throws on a mismatch.
  // That does leak the token's length, which is not worth defending: the
  // length is a configuration detail, not a secret.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new HttpError(401, "bad companion token");
  }
}

export async function companionClaim(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const claimed = await claimNextDispatch();
  if (!claimed) {
    // 204 rather than an empty 200: the companion polls, and most polls find
    // nothing. A distinct status keeps "nothing to do" out of the error path.
    noContent(res);
    return;
  }
  json(res, 200, claimed);
}

export async function companionStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson<{ id?: unknown }>(req);
  const id = requireString(body.id, "id", { max: 64 });
  json(res, 200, { ok: await markDispatchRunning(id) });
}

export async function companionEvents(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson<{ events?: unknown }>(req);
  if (!Array.isArray(body.events)) {
    throw new HttpError(400, "events must be an array");
  }
  if (body.events.length > 200) {
    throw new HttpError(400, "at most 200 events per batch");
  }

  // Room ids come from the database, never from the body. Resolved once per
  // distinct command so a 200-row batch is a handful of lookups, not 200.
  const roomByCommand = new Map<string, string>();

  const events: Awaited<ReturnType<typeof resolveEvent>>[] = [];
  for (let i = 0; i < body.events.length; i += 1) {
    events.push(await resolveEvent(body.events[i], i, roomByCommand));
  }

  await postSessionEvents(events);
  noContent(res);
}

async function resolveEvent(
  raw: unknown,
  i: number,
  roomByCommand: Map<string, string>
) {
    const e = raw as Record<string, unknown>;
    const kind = String(e.kind);
    if (!EVENT_KINDS.has(kind as SessionEventKind)) {
      throw new HttpError(400, `events[${i}].kind is not a known kind: ${kind}`);
    }
    if (typeof e.seq !== "number" || !Number.isInteger(e.seq) || e.seq < 0) {
      throw new HttpError(400, `events[${i}].seq must be a non-negative integer`);
    }
    const commandId = requireString(e.commandId, `events[${i}].commandId`, { max: 64 });

    let roomId = roomByCommand.get(commandId);
    if (!roomId) {
      const found = await dispatchRoom(commandId);
      if (!found) throw new HttpError(404, `events[${i}].commandId is not a known dispatch`);
      roomByCommand.set(commandId, found);
      roomId = found;
    }

    return {
      commandId,
      roomId,
      seq: e.seq,
      kind: kind as SessionEventKind,
      // Labels are a tool name or a path, never prose, so they stay short.
      label: e.label === undefined || e.label === null ? undefined : String(e.label).slice(0, 300),
      body: e.body === undefined || e.body === null ? undefined : String(e.body).slice(0, 8000),
      metadata: (e.metadata ?? undefined) as Record<string, unknown> | undefined,
    };
}

export async function companionFinish(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson<{ id?: unknown; status?: unknown; reply?: unknown }>(req);
  const id = requireString(body.id, "id", { max: 64 });
  const status = requireString(body.status, "status", { max: 16 });

  // Deliberately NOT from the body. See dispatchRoom.
  const roomId = await dispatchRoom(id);
  if (!roomId) throw new HttpError(404, "no such dispatch");

  if (status !== "done" && status !== "failed") {
    throw new HttpError(400, "status must be done or failed");
  }

  let scrubbed = 0;
  const reply = body.reply === undefined || body.reply === null ? "" : String(body.reply);

  if (reply.trim().length > 0) {
    // Post the reply BEFORE marking terminal. If the process dies between the
    // two, a retry re-posts the reply and the second finish is a no-op, which
    // is a duplicate message. The other order loses the reply entirely. A
    // duplicate is recoverable by a human; a silent loss is not.
    const posted = await postAgentReply(roomId, reply.slice(0, 20000));
    scrubbed = posted.scrubbed;
  }

  const ok = await finishDispatch(id, status);
  json(res, 200, { ok, scrubbed });
}
