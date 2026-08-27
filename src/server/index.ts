// The server.
//
//   node dist/server/index.js
//
// One process serves the API and the UI. There is no build step for the client:
// the page is a string in ./ui.js and talks to the same origin, which is what
// lets a self-hosted install be a single command.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { HttpError, html, json } from "./respond.js";
import { requireSession, login, logout, getRooms, postRoom, getRoster, getPosts, postMessage, postReaction, postRead, postHeartbeat, getEvents, type Ctx } from "./routes.js";
import { requireCompanion, companionClaim, companionStart, companionEvents, companionFinish } from "./companion-routes.js";
import { page } from "./ui.js";

const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HANGAR_BIND ?? "127.0.0.1";

/** `/api/rooms/:roomId/posts` -> ["rooms", "<id>", "posts"] */
function segments(pathname: string): string[] {
  return pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const method = req.method ?? "GET";

  // --- the page ---
  if (!url.pathname.startsWith("/api/")) {
    if (method !== "GET") throw new HttpError(405, "method not allowed");
    html(res, 200, page());
    return;
  }

  const seg = segments(url.pathname);

  // --- companion path: bearer token, no session ---
  if (seg[0] === "companion") {
    requireCompanion(req);
    if (method === "POST" && seg[1] === "claim") return companionClaim(req, res);
    if (method === "POST" && seg[1] === "start") return companionStart(req, res);
    if (method === "POST" && seg[1] === "events") return companionEvents(req, res);
    if (method === "POST" && seg[1] === "finish") return companionFinish(req, res);
    throw new HttpError(404, "no such companion route");
  }

  // --- session lifecycle ---
  if (seg[0] === "login" && method === "POST") return login(req, res);
  if (seg[0] === "logout" && method === "POST") return logout(req, res);

  // --- everything else needs a session ---
  const userId = requireSession(req);
  const ctx: Ctx = { req, res, url, userId };

  if (seg[0] === "me" && method === "GET") {
    json(res, 200, { userId });
    return;
  }
  if (seg[0] === "roster" && method === "GET") return getRoster(ctx);

  if (seg[0] === "rooms") {
    if (seg.length === 1 && method === "GET") return getRooms(ctx);
    if (seg.length === 1 && method === "POST") return postRoom(ctx);

    const roomId = seg[1];
    if (!roomId) throw new HttpError(404, "no such route");

    // The longer path FIRST. Matching on seg[2] alone would send
    // /rooms/:id/posts/:postId/reactions to postMessage, because it is also a
    // POST whose third segment is "posts". That bug shipped and the end to end
    // test caught it; a handler-level test never would have, because it calls
    // the handler the router should have chosen.
    if (seg.length === 5 && seg[2] === "posts" && seg[4] === "reactions" && method === "POST") {
      const postId = seg[3];
      if (!postId) throw new HttpError(404, "no such route");
      return postReaction(ctx, roomId, postId);
    }

    if (seg.length === 3) {
      if (seg[2] === "posts" && method === "GET") return getPosts(ctx, roomId);
      if (seg[2] === "posts" && method === "POST") return postMessage(ctx, roomId);
      if (seg[2] === "read" && method === "POST") return postRead(ctx, roomId);
      if (seg[2] === "heartbeat" && method === "POST") return postHeartbeat(ctx, roomId);
      if (seg[2] === "events" && method === "GET") return getEvents(ctx, roomId);
    }
  }

  throw new HttpError(404, "no such route");
}

const server = createServer((req, res) => {
  route(req, res).catch((err: unknown) => {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.message });
      return;
    }
    // Never send an internal error's text to a client. A database error
    // message can carry a table name, a constraint, or a fragment of a value.
    console.error("[hangar] unhandled:", err);
    if (!res.headersSent) json(res, 500, { error: "internal error" });
    else res.end();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Hangar listening on http://${HOST}:${PORT}`);
  if (HOST === "0.0.0.0") {
    console.log("");
    console.log("  WARNING: bound to every interface. Hangar has no transport");
    console.log("  security of its own, so put it behind a TLS terminator or");
    console.log("  bind it to localhost and reach it through a tunnel.");
    console.log("");
  }
});

// A dropped connection mid-request is normal; do not take the process down.
server.on("clientError", (_err, socket) => {
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});
