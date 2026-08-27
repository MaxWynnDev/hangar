// Turning Claude Code's stream-json output into console rows.
//
// toEvent is pure, so it can be tested without spawning anything. Worth saying
// out loud: the rest of companion/src/session.ts, the part that actually spawns
// Claude Code and manages the git worktree, has no coverage here. It needs a
// real repo and a real claude binary. These tests cover the mapping only.

import { test } from "node:test";
import assert from "node:assert/strict";

import { toEvent } from "../dist-test/companion/src/session.js";

const CMD = "disp_1";
const ROOM = "room_1";
const map = (line, seq = 0) => toEvent(line, seq, CMD, ROOM);

test("noise maps to nothing", () => {
  for (const input of [null, undefined, "a string", 42, {}, { type: "unknown" }]) {
    assert.equal(map(input), null, `input ${JSON.stringify(input)}`);
  }
});

test("assistant text becomes a message row", () => {
  const ev = map({ type: "assistant", message: { content: [{ type: "text", text: "on it" }] } });
  assert.equal(ev.kind, "message");
  assert.equal(ev.body, "on it");
  assert.equal(ev.commandId, CMD);
  assert.equal(ev.roomId, ROOM);
});

test("whitespace-only text is dropped rather than posted blank", () => {
  const ev = map({ type: "assistant", message: { content: [{ type: "text", text: "   \n " }] } });
  assert.equal(ev, null);
});

test("a long message is truncated, not dropped", () => {
  const ev = map({ type: "assistant", message: { content: [{ type: "text", text: "x".repeat(9000) }] } });
  assert.equal(ev.body.length, 4000);
});

test("thinking carries no body", () => {
  const ev = map({ type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm" }] } });
  assert.equal(ev.kind, "thinking");
  assert.equal(ev.body, "");
});

test("Bash becomes an exec row with the command as the object", () => {
  const ev = map({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }] },
  });
  assert.equal(ev.kind, "exec");
  assert.equal(ev.label, "Bash");
  assert.equal(ev.metadata.verb, "Ran");
  assert.equal(ev.metadata.object, "npm test");
  assert.equal(ev.metadata.tone, "read");
  assert.equal(ev.metadata.toolUseId, "t1");
});

test("Edit and Write become edit rows toned as writes", () => {
  for (const name of ["Edit", "Write", "MultiEdit"]) {
    const ev = map({
      type: "assistant",
      message: { content: [{ type: "tool_use", name, input: { file_path: "src/a.ts" } }] },
    });
    assert.equal(ev.kind, "edit", name);
    assert.equal(ev.metadata.tone, "write", name);
    assert.equal(ev.metadata.object, "src/a.ts", name);
  }
});

test("Read and Grep stay read-toned tool rows", () => {
  const read = map({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "src/b.ts" } }] },
  });
  assert.equal(read.kind, "tool");
  assert.equal(read.metadata.verb, "Read");
  assert.equal(read.metadata.tone, "read");

  const grep = map({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Grep", input: { pattern: "TODO" } }] },
  });
  assert.equal(grep.metadata.verb, "Searched");
  assert.equal(grep.metadata.object, "TODO");
});

test("an unknown tool still produces a row", () => {
  // A new tool name must not make the console go silent.
  const ev = map({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "SomeFutureTool", input: {} }] },
  });
  assert.equal(ev.kind, "tool");
  assert.equal(ev.label, "SomeFutureTool");
  assert.equal(ev.metadata.verb, "Used");
  assert.equal(ev.metadata.object, "");
});

test("a tool with no recognised input field gets an empty object, not undefined", () => {
  const ev = map({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Bash", input: { weird: "x" } }] },
  });
  assert.equal(ev.metadata.object, "");
});

test("a long tool object is truncated", () => {
  const ev = map({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Bash", input: { command: "y".repeat(500) } }] },
  });
  assert.equal(ev.metadata.object.length, 200);
});

test("the result line marks the run finished or failed", () => {
  assert.equal(map({ type: "result", is_error: false }).label, "finished");
  assert.equal(map({ type: "result", is_error: true }).label, "failed");
  assert.equal(map({ type: "result" }).kind, "status");
});

test("the sequence number is carried through", () => {
  const ev = map({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }, 7);
  assert.equal(ev.seq, 7);
});

test("only the first interesting block of a message is emitted", () => {
  // Known limitation, asserted so a change to it is deliberate. A single
  // assistant message carrying text and a tool call yields one row.
  const ev = map({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "let me look" },
        { type: "tool_use", name: "Read", input: { file_path: "a.ts" } },
      ],
    },
  });
  assert.equal(ev.kind, "message");
});
