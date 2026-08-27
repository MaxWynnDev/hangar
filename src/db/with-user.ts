// Scoped database access.
//
// THIS IS THE ONLY CORRECT WAY TO READ OR WRITE CONVERSATION.
//
// Every policy in db/schema/04_policies.sql keys on `app.user_id`. That setting
// is transaction-local: `set_config(name, value, true)` is the function form of
// SET LOCAL, so the value dies at COMMIT or ROLLBACK.
//
// Two things follow, and both are the reason this wrapper exists rather than a
// bare `SET`:
//
//   1. Without a surrounding transaction the setting would persist on the
//      pooled connection after the request finished, and the next request to
//      check that connection out would run as the previous user. Through a
//      transaction-mode pooler that is a cross-user read, not a stale variable.
//
//   2. Forgetting to set it at all does not fail loudly. Every policy evaluates
//      false and every query returns zero rows. That is the correct direction
//      to fail, but it reads in the UI as "no messages" rather than as an
//      error, which is a genuinely confusing bug to chase. If a room looks
//      empty and the database says otherwise, this is the first thing to check.

import { sql, type Tx } from "./client.js";

/**
 * Run queries as `userId`, inside one transaction, with row level security
 * scoped to that person.
 *
 *   const posts = await withUser(session.userId, (tx) =>
 *     tx`SELECT * FROM room_posts WHERE room_id = ${roomId} ORDER BY created_at`
 *   );
 *
 * Anything the policies refuse comes back as zero rows or throws, depending on
 * whether it was a read or a write. Neither is something to paper over.
 */
export async function withUser<T>(
  userId: string,
  fn: (tx: Tx) => Promise<T>
): Promise<T> {
  if (!userId) {
    // An empty identity would scope every policy to nobody and silently return
    // nothing, which looks exactly like an empty account. Refuse instead.
    throw new Error("withUser: a user id is required");
  }

  return sql.begin(async (tx) => {
    await tx`SELECT app_set_user(${userId})`;
    return fn(tx as Tx);
  }) as Promise<T>;
}

/**
 * Run queries with NO user scope, for the companion path only.
 *
 * The companion is a process on someone's machine. It has no user identity, so
 * the member-scoped policies can never admit it, and the functions it calls are
 * SECURITY DEFINER with no user check. Their only guard is the bearer token on
 * the single route that reaches them.
 *
 * Do not reach for this because a query "did not work". A query returning zero
 * rows under withUser is the access model answering, not a problem to route
 * around. Every use of this outside src/lib/dispatch.ts is a bug.
 */
export async function withoutUserScope<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => fn(tx as Tx)) as Promise<T>;
}
