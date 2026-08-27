// Running one Claude Code session and turning its output into console rows.
//
// The session runs in a git worktree, never in the working copy you are sitting
// in. Two reasons, and the second is the important one:
//
//   1. The agent can change files without fighting your editor.
//   2. Everything it does is on a branch you can read, diff, and throw away.
//      A session that edited your checkout directly would leave you unable to
//      tell its work from your own.

import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";

import type { EventInput } from "./api.js";

const exec = promisify(execFile);

/**
 * How to spawn a session, per platform.
 *
 * On Windows the npm install of Claude Code is a `claude.cmd` shim. Two things
 * go wrong there, and both were found on the first real run:
 *
 *   1. spawn("claude") is ENOENT, because the shim is claude.cmd.
 *   2. spawn("claude.cmd") is EINVAL, because Node refuses to execute a .cmd
 *      or .bat without a shell (the CVE-2024-27980 fix). Naming the shim is
 *      not enough; it needs a shell.
 *
 * So Windows goes through `cmd.exe /c`, which can run the shim. That is chosen
 * over `shell: true` on purpose: shell mode concatenates the arguments instead
 * of escaping them (Node warns about it, DEP0190), and here they are passed as
 * a real argv with no shell parsing at any layer.
 *
 * Either way the brief goes in on stdin, never as an argument, so no room text
 * ever reaches a command line.
 */
export function claudeSpawn(args: string[]): { bin: string; argv: string[] } {
  const claude = process.env.HANGAR_CLAUDE_BIN ?? (process.platform === "win32" ? "claude.cmd" : "claude");
  return process.platform === "win32"
    ? { bin: process.env.COMSPEC ?? "cmd.exe", argv: ["/c", claude, ...args] }
    : { bin: claude, argv: args };
}

/**
 * Reject a request id that cannot safely become a path or a branch name.
 *
 * The companion takes this from whatever server it is pointed at and puts it
 * into a directory path and a git branch. execFile means there is no shell to
 * inject into, but `../../..` would still place a worktree outside the repo,
 * and this process exists to run code. A server the companion trusts should
 * still not be able to choose arbitrary paths on the machine.
 */
export function assertSafeCommandId(commandId: string): void {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(commandId)) {
    throw new Error(
      `refusing a dispatch id that is not a plain token: ${JSON.stringify(commandId.slice(0, 80))}`
    );
  }
}

export interface RunOptions {
  repoPath: string;
  prompt: string;
  commandId: string;
  roomId: string;
  /** Called with each batch of console rows as they arrive. */
  onEvents: (events: EventInput[]) => void;
  /** Hard stop, so a stuck session cannot hold the queue forever. */
  timeoutMs?: number;
}

export interface RunResult {
  reply: string;
  status: "done" | "failed";
  branch: string;
  /** False when the session changed nothing, which is normal for a question. */
  committed: boolean;
}

/**
 * A worktree per session, named after the request.
 *
 * It lands under .hangar-worktrees/ inside the target repo, so add that to that
 * repo's .gitignore. The directory is removed when the session ends; the branch
 * it committed to survives, which is how you review what the session did.
 *
 * Clears any debris from a previous attempt at the same request first. A
 * companion that is killed mid-session, and there are plenty of ways for that
 * to happen, never reaches its cleanup, so both the worktree and the branch are
 * still there. `worktree add -b` then fails with "a branch named ... already
 * exists" and that request can never be retried. Observed on the very first
 * real run of this code.
 *
 * Deleting the old branch is deliberate. A retry of a request that never
 * finished should start from HEAD, not resume half of someone else's attempt.
 */
export async function createWorktree(repoPath: string, commandId: string): Promise<{ dir: string; branch: string }> {
  assertSafeCommandId(commandId);
  const branch = `hangar/${commandId}`;
  const dir = `${repoPath}/.hangar-worktrees/${commandId}`;

  // All three are best-effort: on a clean run there is nothing to remove.
  await exec("git", ["worktree", "remove", "--force", dir], { cwd: repoPath }).catch(() => {});
  await exec("git", ["worktree", "prune"], { cwd: repoPath }).catch(() => {});
  await exec("git", ["branch", "-D", branch], { cwd: repoPath }).catch(() => {});

  await exec("git", ["worktree", "add", "-b", branch, dir, "HEAD"], { cwd: repoPath });
  return { dir, branch };
}

/**
 * Commit whatever the session left behind.
 *
 * This has to happen before the worktree is removed. `git worktree remove
 * --force` deletes the directory and everything uncommitted in it, so without
 * this the session's work is destroyed and the branch named in the brief points
 * at the same commit the session started from.
 *
 * Identity is passed with -c rather than read from config, so this works in a
 * checkout where user.name and user.email were never set.
 *
 * Returns false when the session changed nothing, which is normal for a
 * question that only needed reading.
 */
export async function commitWork(dir: string, commandId: string): Promise<boolean> {
  await exec("git", ["add", "-A"], { cwd: dir });

  const { stdout } = await exec("git", ["status", "--porcelain"], { cwd: dir });
  if (stdout.trim().length === 0) return false;

  await exec(
    "git",
    [
      "-c",
      "user.name=Hangar",
      "-c",
      "user.email=hangar@localhost",
      "commit",
      "-m",
      `hangar: ${commandId}`,
    ],
    { cwd: dir }
  );
  return true;
}

export async function removeWorktree(repoPath: string, dir: string): Promise<void> {
  // --force because the session may have left untracked files. Stale worktrees
  // accumulate and git starts complaining about a branch checked out somewhere
  // nobody can find. The branch itself survives this, which is the point: the
  // work is on it, and you review or delete it later.
  await exec("git", ["worktree", "remove", "--force", dir], { cwd: repoPath }).catch(() => {});
}

/** Map one stream-json line to a console row, or null to ignore it. */
export function toEvent(line: unknown, seq: number, commandId: string, roomId: string): EventInput | null {
  const e = line as Record<string, any>;
  if (!e || typeof e !== "object") return null;

  const base = { commandId, roomId, seq };

  if (e.type === "assistant" && e.message?.content) {
    for (const block of e.message.content) {
      if (block.type === "text" && block.text?.trim()) {
        return { ...base, kind: "message", body: String(block.text).slice(0, 4000) };
      }
      if (block.type === "thinking") {
        return { ...base, kind: "thinking", body: "" };
      }
      if (block.type === "tool_use") {
        const name = String(block.name ?? "tool");
        const input = block.input ?? {};
        const target = input.file_path ?? input.path ?? input.command ?? input.pattern ?? "";
        return {
          ...base,
          kind: name === "Bash" ? "exec" : /Edit|Write/.test(name) ? "edit" : "tool",
          label: name,
          metadata: {
            verb: verbFor(name),
            object: String(target).slice(0, 200),
            tone: /Edit|Write/.test(name) ? "write" : "read",
            status: "executing",
            toolUseId: block.id,
          },
        };
      }
    }
    return null;
  }

  if (e.type === "result") {
    return { ...base, kind: "status", label: e.is_error ? "failed" : "finished" };
  }

  return null;
}

function verbFor(tool: string): string {
  if (tool === "Bash") return "Ran";
  if (tool === "Read") return "Read";
  if (tool === "Write") return "Created";
  if (tool === "Edit" || tool === "MultiEdit") return "Edited";
  if (tool === "Grep" || tool === "Glob") return "Searched";
  return "Used";
}

/**
 * Run the session.
 *
 * Uses stream-json so the console fills as work happens rather than at the end.
 * The prompt is passed on stdin, not as an argument: a long brief on a command
 * line is a portability problem and shows up in the process table, where the
 * room's text does not belong.
 */
export async function runSession(opts: RunOptions): Promise<RunResult> {
  const { dir, branch } = await createWorktree(opts.repoPath, opts.commandId);
  const timeoutMs = opts.timeoutMs ?? 20 * 60 * 1000;

  let seq = 0;
  let reply = "";
  let failed = false;
  let committed = false;
  let batch: EventInput[] = [];

  const flush = () => {
    if (batch.length === 0) return;
    const out = batch;
    batch = [];
    opts.onEvents(out);
  };

  try {
    const { bin, argv } = claudeSpawn([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
    ]);
    const child = spawn(bin, argv, { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });

    // Without this, a binary that cannot be spawned raises an unhandled 'error'
    // event and takes the whole companion down, so one bad dispatch ends every
    // future one too. Record it and let the session finish as failed instead.
    let spawnError: Error | null = null;
    child.on("error", (err) => {
      spawnError = err;
      failed = true;
    });

    child.stdin.on("error", () => {
      // Writing the prompt to a process that never started throws EPIPE. The
      // 'error' handler above already has the real reason.
    });

    child.stdin.write(opts.prompt);
    child.stdin.end();

    const timer = setTimeout(() => {
      failed = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    const rl = createInterface({ input: child.stdout });
    const pump = setInterval(flush, 1000);

    for await (const raw of rl) {
      if (!raw.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue; // Non-JSON noise on stdout is not fatal.
      }

      const p = parsed as Record<string, any>;
      if (p.type === "result" && typeof p.result === "string") {
        reply = p.result;
        if (p.is_error) failed = true;
      }

      const ev = toEvent(parsed, seq, opts.commandId, opts.roomId);
      if (ev) {
        batch.push(ev);
        seq += 1;
      }
    }

    clearTimeout(timer);
    clearInterval(pump);
    flush();

    const code: number = await new Promise((resolve) => {
      child.on("close", resolve);
      child.on("error", () => resolve(-1));
    });
    if (code !== 0) failed = true;

    if (spawnError) {
      const err = spawnError as Error & { code?: string };
      reply =
        err.code === "ENOENT"
          ? `Could not start ${bin}. Is Claude Code installed and on PATH? ` +
            `Set HANGAR_CLAUDE_BIN to its full path if it is somewhere else.`
          : `Could not start ${bin}: ${err.message}`;
    }
  } finally {
    // Commit inside finally so a session that threw partway still keeps what it
    // changed. A crashed session that edited three files is worth more than an
    // empty branch.
    try {
      committed = await commitWork(dir, opts.commandId);
    } catch {
      // A failed commit must not stop the worktree being removed, or the next
      // session for this repo collides with a directory that is still there.
    }
    await removeWorktree(opts.repoPath, dir);
  }

  return {
    reply: reply || (failed ? "The session ended without producing a reply." : ""),
    status: failed ? "failed" : "done",
    branch,
    committed,
  };
}
