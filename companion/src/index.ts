// The Hangar companion.
//
//   HANGAR_URL=... HANGAR_COMPANION_TOKEN=... HANGAR_REPO=... node dist/companion/index.js
//
// It polls Hangar for a queued request, runs a Claude Code session in a fresh
// git worktree, streams the session's activity back as console rows, and posts
// the reply into the room.
//
// WHAT THIS PROCESS IS. It runs an agent with tool permissions bypassed against
// a repository on this machine. Anyone who can queue a dispatch in Hangar can
// cause that to happen here. Run it on a machine you own, against a repository
// you are willing to see changed, with a Hangar whose roster you trust. Those
// are the actual boundaries; nothing in the code can widen or narrow them.
//
// One session at a time, deliberately. The database already enforces one live
// dispatch per room, but a single companion running one session keeps the
// machine's load predictable and makes the logs readable in an incident.

import { loadConfig, HangarClient, type Claimed } from "./api.js";
import { runSession } from "./session.js";
import { buildDispatchPrompt } from "../../src/lib/dispatch-prompt.js";

const cfg = loadConfig();
const client = new HangarClient(cfg);

let stopping = false;

async function handle(job: Claimed): Promise<void> {
  const started = Date.now();
  console.log(`[hangar] claimed ${job.id} for room ${job.roomId}`);

  await client.start(job.id).catch((e) => console.warn("[hangar] start failed:", e.message));

  // The brief is built HERE, on the machine that runs the session, from the ask
  // the server handed over. The neutralizing and fencing in buildDispatchPrompt
  // is the only thing between a chat message and a tool call.
  const prompt = buildDispatchPrompt({
    roomSlug: job.roomId,
    askedBy: "a teammate",
    ask: job.ask,
    branch: `hangar/${job.id}`,
  });

  let status: "done" | "failed" = "failed";
  let reply = "";

  try {
    const result = await runSession({
      repoPath: cfg.repoPath,
      prompt,
      commandId: job.id,
      roomId: job.roomId,
      onEvents: (events) => {
        // Console rows are a live convenience. Losing a batch must never abort
        // a session that is doing real work in a real repository.
        client.events(events).catch((e) => console.warn("[hangar] events dropped:", e.message));
      },
    });
    status = result.status;
    reply = result.reply;
  } catch (err) {
    console.error("[hangar] session error:", err);
    reply = `The session could not run: ${err instanceof Error ? err.message : String(err)}`;
    status = "failed";
  }

  try {
    const out = await client.finish(job.id, status, reply);
    const secs = Math.round((Date.now() - started) / 1000);
    console.log(`[hangar] finished ${job.id} as ${status} in ${secs}s`);
    if (out.scrubbed > 0) {
      // Not a normal event. Something upstream handed the session a credential
      // it did not need, and the scrubber caught it on the way out.
      console.warn(`[hangar] WARNING: ${out.scrubbed} secret(s) redacted from the reply`);
    }
  } catch (err) {
    // The work happened. Losing the completion means the request stays claimed
    // until it expires, which is visible in the room rather than silent.
    console.error("[hangar] could not report completion:", err);
  }
}

async function loop(): Promise<void> {
  console.log(`[hangar] companion polling ${cfg.baseUrl} every ${cfg.pollSeconds}s`);
  console.log(`[hangar] repository: ${cfg.repoPath}`);

  while (!stopping) {
    let job: Claimed | null = null;
    try {
      job = await client.claim();
    } catch (err) {
      // A bad token is fatal and already threw a clear message. Anything else
      // is probably the server restarting, so back off and keep going.
      if (String(err).includes("companion token")) {
        console.error(String(err));
        process.exit(1);
      }
      console.warn("[hangar] claim failed, backing off:", err instanceof Error ? err.message : err);
      await sleep(cfg.pollSeconds * 4000);
      continue;
    }

    if (!job) {
      await sleep(cfg.pollSeconds * 1000);
      continue;
    }

    await handle(job);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (stopping) process.exit(1); // A second one means impatience; honour it.
    stopping = true;
    console.log("\n[hangar] finishing the current session, press again to force quit");
  });
}

loop().catch((err) => {
  console.error("[hangar] fatal:", err);
  process.exit(1);
});
