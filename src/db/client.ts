// The database connection.
//
// One pool for the process. Every query that touches conversation must go
// through `withUser` in ./with-user.ts, never through this export directly,
// because row level security keys on a transaction-local setting that only
// that wrapper sets.
//
// The one legitimate direct use is the companion path, which has no user
// identity by design. Those call sites are in src/lib/dispatch.ts and are the
// only ones.

import postgres from "postgres";

const url = process.env.DATABASE_URL;

if (!url) {
  throw new Error(
    "DATABASE_URL is not set. Hangar cannot start without a database."
  );
}

/**
 * Connect as the application role, never as the owner.
 *
 * Every governed table is FORCE ROW LEVEL SECURITY, which subjects the owner to
 * its own policies, but the owner can still ALTER them away. Running migrations
 * as one role and traffic as another is what keeps a bug in a request handler
 * from being able to rewrite the access model.
 */
export const sql = postgres(url, {
  max: Number(process.env.DATABASE_POOL_MAX ?? 10),
  idle_timeout: 30,
  connect_timeout: 10,
  onnotice: () => {},
  // Postgres NOTICE output is not application output. Swallowing it here keeps
  // "raise notice" debugging in a function from reaching a user's log stream.
});

export type Sql = typeof sql;

/**
 * A transaction handle. Shaped so callers cannot tell it from `sql`, which is
 * deliberate: a query written against one works against the other, so moving a
 * query into or out of a transaction is not a rewrite.
 */
export type Tx = postgres.TransactionSql<Record<string, unknown>>;
