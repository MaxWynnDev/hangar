# Hangar

Team chat where `@claude` is a real Claude Code session.

You talk in rooms like any chat app. When you write `@claude fix the flaky login test`,
a real Claude Code session starts on a machine you control, works in your repo, and
posts what it did back into the room. While it runs you get a live console of what it's
actually doing: files it read, commands it ran, edits it made.

Claude's replies show up as normal messages, same as everyone else's. Its work goes in a
separate panel so one session firing off a hundred tool calls doesn't bury the
conversation.

> **Status: works, but it's new.** The whole flow runs and CI checks it against a real
> Postgres on every push. It hasn't been run in anger yet. See
> [What's built](#whats-built).

---

## How it works

Two processes.

The **server** holds the database and serves the rooms. It can't execute anything.

The **companion** runs on your own machine next to your repo. It polls the server, picks
up a request, runs the session, streams back what happened. It gets a bearer token and no
database credentials, so if the laptop gets stolen you haven't lost the database.

The web app never spawns a process. If you change that you've changed the security model.

## Security

Hangar lets people in a chat room start a Claude Code session with permissions bypassed
against a repo on your machine. That's what it's for. If that's not OK for your
situation, don't run it.

`SECURITY.md` has the full threat model. The short version:

Every table has RLS forced on. The app connects as `hangar_app`, which owns nothing and
can't bypass RLS. Policies key on a transaction-local `app.user_id` that only `withUser()`
sets, so forgetting it returns zero rows instead of everything.

You reach a room two ways: you're a member of it, or it's a shared session and you're on
the roster. Either way you have to be on the roster first. A room that isn't a session
stays private to its members.

Claude's messages can't be faked. The insert policy only accepts `author_kind = 'user'`
bound to whoever is calling, so the app role can't write an agent post at all. They only
come in through a `SECURITY DEFINER` function.

`src/lib/dispatch-prompt.ts` is the only thing between a chat message and a tool call,
because the session runs with tool permissions bypassed. Room text gets NFKC folded, so a
fullwidth bracket can't survive the ASCII strip. Every Unicode format character is
stripped, because bidi overrides make a human's view differ from the model's, which wrecks
the audit trail. Then it's fenced and labelled as data.

## What's built

| | |
|---|---|
| Schema, RLS, grants | applied to Postgres 16 in CI, twice per run |
| RLS and dispatch queue | 29 tests against a real database |
| Prompt boundary, auth, domain logic | 57 unit tests |
| Server, API, UI, companion | 8 end to end tests against the built server |
| Term gate | runs pre-commit and in CI |
| Threads, search, attachments, editing | not built |
| Identity provider | not shipped, see below |

I've watched each of those suites fail, which is why I trust them:

- Widening one RLS policy to `USING (true)` failed exactly the two tests that read as a
  non-member. The rest stayed green.
- Removing the character folding from the prompt boundary failed its three tests. One of
  them had to be rewritten first because it was passing for the wrong reason.
- The end to end suite caught a routing bug on its first run. Reactions were being
  handled as new messages because their path is also a POST ending in `posts`.
- A pre-publication audit found 12 real issues out of 56 candidates. The worst one: the
  roster gated almost nothing, so someone signed in but off the roster could create a
  room, add themselves, and queue a dispatch.

## Running it

```bash
npm install
cp .env.example .env      # fill it in

DATABASE_URL=postgres://... npm run db:apply
DATABASE_URL=postgres://... npm run bootstrap you@example.com "Your Name"

npm run build
npm start                 # http://127.0.0.1:4000
```

`bootstrap` prints the two secrets you need. It exists because adding someone to the
roster requires already being on it, so the first person has to come from whoever has the
database credentials. After that the roster manages itself.

Then on the machine with the repo you want Claude working in:

```bash
HANGAR_URL=http://127.0.0.1:4000 \
HANGAR_COMPANION_TOKEN=... \
HANGAR_REPO=/path/to/repo \
npm run companion
```

### Sign-in

There's no identity provider in here. `HANGAR_TRUSTED_LOGIN=true` turns on email-only
sign-in with no password, which is only safe behind something that already authenticates.
The server won't do it unless you set that explicitly. To wire up OIDC, replace
`readSession` in `src/server/auth.ts`. Nothing else cares how the session got made.

### Tests

```bash
npm run verify                                  # types, unit tests, terms
DATABASE_URL=postgres://... npm run test:db     # policies and the queue
DATABASE_URL=postgres://... npm run test:e2e    # the whole flow
```

The RLS suite won't run unless its connection is actually subject to RLS. It checks that
`current_user` is the app role, isn't a superuser, doesn't have `BYPASSRLS`, and that
every table is forced. Run it as superuser and it stops instead of passing.

## Keeping private terms out

Client names, internal service names, industry vocabulary, machine paths, and credentials
must never land in this repo, and I don't rely on remembering.

`scripts/check-no-leaks.mjs` scans the working tree and every object in history, on every
commit and in CI. History matters because something committed and later deleted still
ships to anyone who clones.

The term list stays out of the repo, in a gitignored `.provenance-terms.mjs`. It names the
things I'm keeping out, so it can't live in here either.
`.provenance-terms.example.mjs` shows the format and is what CI runs against. Every rule
declares what it has to catch and what it has to ignore, and `test/leak-gate.test.mjs`
checks both directions, so a rule that quietly stopped matching fails the build instead of
passing. It's caught a planted fixture and a term I'd committed and deleted.

```bash
npm run verify
```

## License

MIT.

