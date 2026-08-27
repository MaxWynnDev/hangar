// The client.
//
// One string, no build step, no framework. That is a deliberate trade: a
// self-hosted Hangar is `node dist/server/index.js` and nothing else, and the
// whole client is readable in one sitting.
//
// It polls rather than holding a socket. Polling is unfashionable and correct
// here: rooms are small, a poll survives a laptop sleeping and a proxy dropping
// idle connections, and there is no reconnect state machine to get wrong. If
// this ever serves large rooms, the place to change is `tick()`.

export function page(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hangar</title>
<style>
  :root {
    --bg: #191817; --panel: #1f1e1d; --line: #302e2c;
    --ink: #e8e5e0; --dim: #a09a92; --faint: #6f6a64;
    --accent: #d97757; --agent: #b4d0e8;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
         font: 14px/1.55 var(--mono); height: 100vh; display: flex; }
  button { font: inherit; cursor: pointer; }

  #sidebar { width: 240px; flex: 0 0 240px; border-right: 1px solid var(--line);
             display: flex; flex-direction: column; background: var(--panel); }
  #sidebar h1 { font-size: 13px; letter-spacing: .12em; text-transform: uppercase;
                color: var(--faint); margin: 0; padding: 16px; border-bottom: 1px solid var(--line); }
  #rooms { flex: 1; overflow-y: auto; }
  .room { padding: 9px 16px; cursor: pointer; color: var(--dim);
          display: flex; justify-content: space-between; gap: 8px; }
  .room:hover { background: #262422; color: var(--ink); }
  .room.active { background: #2b2825; color: var(--ink); border-left: 2px solid var(--accent); padding-left: 14px; }
  .room .n { color: var(--faint); font-size: 12px; }
  .room .badge { background: var(--accent); color: #191817; border-radius: 9px;
                 padding: 0 6px; font-size: 11px; align-self: center; }
  #newroom { border-top: 1px solid var(--line); padding: 10px; }
  #newroom button { width: 100%; background: transparent; color: var(--dim);
                    border: 1px dashed var(--line); border-radius: 6px; padding: 8px; }
  #newroom button:hover { color: var(--ink); border-color: var(--faint); }

  #main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  #head { padding: 14px 20px; border-bottom: 1px solid var(--line); display: flex;
          align-items: baseline; gap: 12px; }
  #head .name { font-weight: 600; }
  #head .topic { color: var(--faint); font-size: 12px; }
  #head .tag { margin-left: auto; font-size: 11px; color: var(--faint);
               border: 1px solid var(--line); border-radius: 4px; padding: 1px 6px; }

  #body { flex: 1; display: flex; min-height: 0; }
  #posts { flex: 1; overflow-y: auto; padding: 16px 20px; }
  .post { display: flex; gap: 10px; padding: 5px 0; }
  .post .who { color: var(--dim); flex: 0 0 auto; }
  .post.agent .who { color: var(--agent); }
  .post .text { white-space: pre-wrap; word-break: break-word; min-width: 0; }
  .post .when { color: var(--faint); font-size: 11px; margin-left: auto; flex: 0 0 auto; }
  .post .rx { margin-top: 3px; display: flex; gap: 4px; flex-wrap: wrap; }
  .rx button { background: #262422; border: 1px solid var(--line); border-radius: 10px;
               color: var(--dim); font-size: 12px; padding: 0 7px; }
  .rx button.mine { border-color: var(--accent); color: var(--ink); }

  #console { width: 320px; flex: 0 0 320px; border-left: 1px solid var(--line);
             background: var(--panel); overflow-y: auto; padding: 12px; display: none; }
  #console.on { display: block; }
  #console h2 { font-size: 11px; letter-spacing: .12em; text-transform: uppercase;
                color: var(--faint); margin: 0 0 10px; }
  .ev { font-size: 12px; padding: 3px 0; color: var(--dim); display: flex; gap: 6px; }
  .ev .k { color: var(--faint); flex: 0 0 52px; }
  .ev.error .k, .ev.error .l { color: #e0796a; }
  .ev .l { word-break: break-word; }

  #foot { border-top: 1px solid var(--line); padding: 12px 20px; }
  #shimmer { color: var(--accent); font-size: 12px; height: 16px; }
  #composer { display: flex; gap: 8px; margin-top: 6px; }
  #composer textarea { flex: 1; background: #171615; color: var(--ink); resize: none;
                       border: 1px solid var(--line); border-radius: 8px; padding: 9px 11px;
                       font: inherit; min-height: 40px; max-height: 160px; }
  #composer textarea:focus { outline: none; border-color: var(--faint); }
  #composer button { background: var(--accent); color: #191817; border: 0;
                     border-radius: 8px; padding: 0 18px; font-weight: 600; }
  #hint { color: var(--faint); font-size: 11px; margin-top: 6px; }

  #gate { margin: auto; text-align: center; max-width: 320px; }
  #gate input { width: 100%; background: #171615; color: var(--ink); font: inherit;
                border: 1px solid var(--line); border-radius: 8px; padding: 10px; }
  #gate button { width: 100%; margin-top: 8px; background: var(--accent); color: #191817;
                 border: 0; border-radius: 8px; padding: 10px; font-weight: 600; }
  #err { color: #e0796a; font-size: 12px; min-height: 16px; margin-top: 8px; }
</style>
</head>
<body>
<div id="app"></div>
<script>
const api = async (path, opts) => {
  const r = await fetch("/api" + path, {
    ...opts,
    headers: { "content-type": "application/json", ...(opts && opts.headers) },
  });
  if (r.status === 204) return null;
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || ("http " + r.status));
  return body;
};

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

const time = (iso) => {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

const REACTIONS = ["👍", "👀", "🎉", "🤔", "🚀"];

const state = { me: null, rooms: [], roomId: null, posts: [], events: [], cursor: 0, busy: false };

async function boot() {
  try {
    const me = await api("/me");
    state.me = me.userId;
    render();
    await refreshRooms();
    tick();
  } catch {
    gate();
  }
}

function gate() {
  document.getElementById("app").innerHTML =
    '<div id="gate"><div style="color:var(--accent);font-weight:600;margin-bottom:14px">Hangar</div>' +
    '<input id="email" type="email" placeholder="you@example.com" autocomplete="email">' +
    '<button id="go">Sign in</button><div id="err"></div></div>';
  const submit = async () => {
    const err = document.getElementById("err");
    err.textContent = "";
    try {
      await api("/login", { method: "POST", body: JSON.stringify({ email: document.getElementById("email").value }) });
      const me = await api("/me").catch(() => null);
      if (!me) { err.textContent = "No account for that address."; return; }
      location.reload();
    } catch (e) { err.textContent = e.message; }
  };
  document.getElementById("go").onclick = submit;
  document.getElementById("email").onkeydown = (e) => { if (e.key === "Enter") submit(); };
}

function render() {
  document.getElementById("app").outerHTML =
    '<div id="sidebar"><h1>Hangar</h1><div id="rooms"></div>' +
    '<div id="newroom"><button id="add">+ new room</button></div></div>' +
    '<div id="main"><div id="head"><span class="name">\\u2014</span></div>' +
    '<div id="body"><div id="posts"></div><div id="console"><h2>session</h2><div id="evs"></div></div></div>' +
    '<div id="foot"><div id="shimmer"></div><div id="composer">' +
    '<textarea id="input" placeholder="Message, or @claude to start a session"></textarea>' +
    '<button id="send">Send</button></div>' +
    '<div id="hint">@claude dispatches a real session. Enter sends, shift+enter for a newline.</div></div></div>';

  document.getElementById("add").onclick = newRoom;
  document.getElementById("send").onclick = send;
  const input = document.getElementById("input");
  input.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  };
}

async function newRoom() {
  const name = prompt("Room name");
  if (!name) return;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64);
  if (!slug) return;
  const session = confirm("Open as a shared session?\\n\\nOK shares it with everyone on the roster.\\nCancel keeps it to the people you add.");
  try {
    const { room } = await api("/rooms", { method: "POST", body: JSON.stringify({ slug, name, session }) });
    await refreshRooms();
    select(room.id);
  } catch (e) { alert(e.message); }
}

async function refreshRooms() {
  const { rooms } = await api("/rooms");
  state.rooms = rooms;
  const el = document.getElementById("rooms");
  el.innerHTML = rooms.map((r) =>
    '<div class="room' + (r.id === state.roomId ? " active" : "") + '" data-id="' + esc(r.id) + '">' +
      '<span><span class="n">' + (r.isSession ? "~" : "#") + '</span> ' + esc(r.name) + '</span>' +
      (r.unread > 0 && r.id !== state.roomId ? '<span class="badge">' + r.unread + '</span>' : "") +
    '</div>').join("");
  el.querySelectorAll(".room").forEach((n) => { n.onclick = () => select(n.dataset.id); });
  if (!state.roomId && rooms.length) select(rooms[0].id);
}

async function select(id) {
  state.roomId = id;
  state.cursor = 0;
  state.events = [];
  const room = state.rooms.find((r) => r.id === id);
  document.getElementById("head").innerHTML =
    '<span class="name">' + esc(room ? room.name : "") + '</span>' +
    '<span class="topic">' + esc(room && room.topic ? room.topic : "") + '</span>' +
    (room && room.isSession ? '<span class="tag">shared session</span>' : "");
  // Shown for any room that has session activity. Keying it on isSession meant
  // a private room could dispatch and stream nothing the whole time.
  document.getElementById("console").className = "";
  await Promise.all([refreshPosts(), refreshEvents()]);
  await api("/rooms/" + id + "/read", { method: "POST" }).catch(() => {});
  await refreshRooms();
}

async function refreshPosts() {
  if (!state.roomId) return;
  const { posts } = await api("/rooms/" + state.roomId + "/posts");
  state.posts = posts;
  const el = document.getElementById("posts");
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  el.innerHTML = posts.map((p) =>
    '<div class="post ' + esc(p.authorKind) + '">' +
      '<span class="who">' + esc(p.authorKind === "agent" ? "claude" : (p.authorLabel || "someone")) + '</span>' +
      '<span class="text">' + esc(p.body) +
        (p.reactions.length ? '<span class="rx">' + p.reactions.map((r) =>
          '<button class="' + (r.mine ? "mine" : "") + '" data-p="' + esc(p.id) + '" data-e="' + esc(r.emoji) + '">' +
          esc(r.emoji) + " " + r.count + "</button>").join("") + "</span>" : "") +
      '</span>' +
      '<span class="when">' + time(p.createdAt) + '</span>' +
    '</div>').join("");
  el.querySelectorAll(".rx button").forEach((b) => {
    b.onclick = async () => {
      await api("/rooms/" + state.roomId + "/posts/" + b.dataset.p + "/reactions",
        { method: "POST", body: JSON.stringify({ emoji: b.dataset.e }) }).catch(() => {});
      refreshPosts();
    };
  });
  if (atBottom) el.scrollTop = el.scrollHeight;
}

async function refreshEvents() {
  if (!state.roomId) return;
  const { events } = await api("/rooms/" + state.roomId + "/events?since=" + state.cursor);
  if (!events.length) return;
  state.events = state.events.concat(events);
  state.cursor = events[events.length - 1].roomSeq;
  document.getElementById("console").className = "on";
  const el = document.getElementById("evs");
  el.innerHTML = state.events.slice(-200).map((e) => {
    const m = e.metadata || {};
    const label = m.verb ? (m.verb + " " + (m.object || "")) : (e.label || e.body || e.kind);
    return '<div class="ev ' + esc(e.kind) + '"><span class="k">' + esc(e.kind) + '</span>' +
           '<span class="l">' + esc(label) + '</span></div>';
  }).join("");
  el.parentElement.scrollTop = el.parentElement.scrollHeight;

  // A terminal status row means the session is over, so stop claiming it is
  // still running. Previously the shimmer ran until you reloaded the page.
  const last = state.events[state.events.length - 1];
  if (last && last.kind === "status" && /finished|failed/.test(last.label || "")) {
    shimmer(false);
  }
}

async function send() {
  const input = document.getElementById("input");
  const body = input.value.trim();
  if (!body || !state.roomId || state.busy) return;
  state.busy = true;
  input.value = "";
  try {
    const r = await api("/rooms/" + state.roomId + "/posts", { method: "POST", body: JSON.stringify({ body }) });
    if (r.dispatched) shimmer(true);
    await refreshPosts();
  } catch (e) {
    input.value = body;
    alert(e.message);
  } finally { state.busy = false; }
}

let shimmerOn = false;
let shimmerTimer = null;
const HEADLINES = ["reading the repo", "thinking it through", "running the tests", "making the change", "checking its work"];
function shimmer(on) {
  shimmerOn = on;
  const el = document.getElementById("shimmer");
  if (!on) { el.textContent = ""; return; }
  let i = 0;
  const step = () => {
    if (!shimmerOn) { el.textContent = ""; return; }
    el.textContent = HEADLINES[i++ % HEADLINES.length] + "\\u2026";
    setTimeout(step, 2200);
  };
  step();
}

async function tick() {
  try {
    if (state.roomId) {
      await refreshPosts();
      await refreshEvents();
      await api("/rooms/" + state.roomId + "/heartbeat", { method: "POST", body: JSON.stringify({ typing: false }) }).catch(() => {});
    }
    await refreshRooms();
  } catch {}
  setTimeout(tick, 3000);
}

boot();
</script>
</body>
</html>`;
}
