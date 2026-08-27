# Security

## What this software does, plainly

Hangar lets people in a chat room cause a Claude Code session to run, with tool
permissions bypassed, against a repository on a machine you control.

That is the product, not a side effect. Everything below is about bounding it.

If that sentence is not acceptable for your situation, no configuration here
makes it acceptable. Do not deploy it.

## The shape of the system

Two processes, and the split is the main control:

**The server** holds the database credentials and serves the rooms. It has no
ability to execute anything. A remote code execution bug in the web tier gets an
attacker the database, which is bad, but not a shell on a developer's machine.

**The companion** runs on a developer's own machine, next to the repository. It
holds a bearer token and no database credentials. It polls the server over HTTP,
claims a queued request, runs the session, and reports back. A stolen laptop is
not a stolen database.

Nothing in the web tier spawns a process. If you change that, you have changed
the security model, not just the implementation.

## Who can do what

| Actor | Can |
|---|---|
| Anyone unauthenticated | Load the page. Nothing else. |
| A signed-in person off the roster | Nothing. Every policy returns zero rows. |
| A person on the roster | Read and post in rooms they belong to, plus every session room. Queue a dispatch. |
| A room owner | Manage that room's roster. |
| Whoever holds the companion token | Claim any queued dispatch, write to any room's console, post as the agent into the room of any dispatch. |
| Whoever holds the database credentials | Everything. |

Note the fourth row. The companion token is powerful and there is exactly one
of it. Treat it like a deploy key: keep it out of shell history and version
control, and rotate it by changing the value and restarting both processes.
There is no revocation list.

## What the database enforces

Not the application. The application could be entirely rewritten and these would
still hold, which is the point of putting them here.

- **Every governed table is `ENABLE` + `FORCE ROW LEVEL SECURITY`.** `FORCE`
  matters: without it the table owner bypasses its own policies, and on a small
  deployment the owner is the role the app connects with.
- **The app connects as `hangar_app`**, which owns nothing and holds no
  `BYPASSRLS`. Migrations run as a different role.
- **Policies key on `app.user_id`**, set transaction-locally by `withUser`.
  Forgetting to set it returns zero rows rather than everything. It fails closed
  and it fails quietly, so an unexpectedly empty room is the first thing to check.
- **Agent posts cannot be forged.** The `INSERT` policy admits
  `author_kind = 'user'` bound to the caller, so the application role cannot
  write an agent message at all. They arrive only through a `SECURITY DEFINER`
  writer.
- **Access has two arms**: a membership row, or the room being a session and you
  being on the roster. A room with no session row is unreachable by the second
  arm, which is what keeps private rooms private while sessions are shared.
- **Grants are half the model.** No `DELETE` on messages, no `INSERT` on console
  events, no write at all on the roster.

These are asserted by `test/rls.test.mjs` against a real Postgres on every push,
and the suite refuses to run unless its connection is genuinely subject to RLS.

## Prompt injection

`src/lib/dispatch-prompt.ts` is the boundary. The session it briefs runs with
tool permissions bypassed, so there is no second prompt behind it and no human
between the message and the tool call.

Room text is treated as untrusted data:

- NFKC normalized first, so a fullwidth bracket cannot survive the ASCII strip.
- Every Unicode format character removed. Bidi overrides matter beyond the
  model: the same text renders in the room, so an override makes what a human
  reviews differ from what the session receives, which breaks the audit trail.
- Fence delimiters stripped, so a value cannot close the block quoting it.
- Runs of blank lines collapsed, which is the padding used to push a fence off a
  reader's screen.
- Context messages collapsed to one line each. That is the one place a
  non-dispatcher writes into a dispatcher's brief, and a newline at column zero
  can forge one of the brief's own headers.

This is a real boundary and it is not a guarantee. A sufficiently clever ask can
still ask the session to do something you would not want. The session is
constrained by what the machine it runs on can reach, which is the control that
actually holds.

## Known weaknesses

Listed rather than left to be discovered.

1. **The companion token is a single shared secret.** No per-companion identity,
   no revocation, no audit of which companion did what.
2. **`HANGAR_TRUSTED_LOGIN` is passwordless by design.** It is only safe behind
   something that already authenticates. The server refuses to enable it
   accidentally, but nothing stops an operator from setting it on the open
   internet.
3. **The reply scrubber is defence in depth, not a control.** It catches known
   credential shapes on the way out. The real control is not handing the session
   credentials it does not need.
4. **Rate limiting is per process and in memory.** A single self-hosted install
   is one process, so this is the global limit. Behind a load balancer it
   silently becomes per-instance.
5. **No transport security of its own.** Put it behind a TLS terminator, or bind
   it to localhost and reach it through a tunnel.
6. **Message bodies are retained forever.** The index for a retention sweep
   exists; the sweep does not. Rooms accumulate whatever people paste into them.
7. **The companion runs sessions with permissions bypassed.** That is the
   feature. It means anyone who can queue a dispatch can cause arbitrary code to
   run on the companion's machine, within that repository.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository rather than a
public issue for anything that would put an existing install at risk.

There is no bounty and no SLA. This is a personal project.
