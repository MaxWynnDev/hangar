// Does re-applying the schema fix up an older install?
//
// The schema is declarative with no migration journal, so the only thing making
// an upgrade work is that every change is written additively. A column added to
// a CREATE TABLE and nowhere else looks fine forever: CREATE TABLE IF NOT
// EXISTS skips a table that is already there, and CI builds an empty database
// every run, so nothing here ever exercises the upgrade path.
//
// This simulates it. Drop a column that a later version introduced, re-apply,
// and check it came back. A missing ALTER fails here instead of on someone's
// install.
//
//   DATABASE_URL=postgres://... node scripts/check-upgrade-path.mjs

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

/**
 * Columns added after their table shipped. Each needs an ALTER in the schema.
 * Add a row here whenever you add a column to an existing table.
 */
const ADDED_LATER = [{ table: "session_events", column: "room_seq" }];

const sql = postgres(url, { max: 1, onnotice: () => {} });

async function hasColumn(table, column) {
  const rows = await sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = ${table} AND column_name = ${column}
  `;
  return rows.length > 0;
}

let failed = false;

try {
  // Start from a fully applied schema.
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "apply-schema.mjs")], {
    cwd: ROOT,
    stdio: "inherit",
  });

  for (const { table, column } of ADDED_LATER) {
    if (!(await hasColumn(table, column))) {
      console.error(`  ${table}.${column} is missing after a normal apply`);
      failed = true;
      continue;
    }

    // Rewind to what an older install looks like.
    await sql.unsafe(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    if (await hasColumn(table, column)) {
      console.error(`  could not drop ${table}.${column} to simulate an older install`);
      failed = true;
      continue;
    }

    execFileSync(process.execPath, [path.join(ROOT, "scripts", "apply-schema.mjs")], {
      cwd: ROOT,
      stdio: "inherit",
    });

    if (await hasColumn(table, column)) {
      console.error(`  ok: ${table}.${column} restored by re-applying`);
    } else {
      console.error(
        `  ${table}.${column} was NOT restored. It is in a CREATE TABLE with no ` +
          `matching ALTER TABLE ... ADD COLUMN IF NOT EXISTS, so an existing ` +
          `install will never get it.`
      );
      failed = true;
    }
  }
} catch (err) {
  console.error(String(err?.message ?? err));
  failed = true;
} finally {
  await sql.end({ timeout: 5 });
}

if (failed) {
  console.error("\nupgrade path is broken");
  process.exit(1);
}
console.error("upgrade path ok");
