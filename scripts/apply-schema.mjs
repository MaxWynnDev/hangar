// Apply db/schema/*.sql in filename order.
//
// The schema is declarative and idempotent: applying it twice is a no-op, not
// an error. There is no migration journal. Every statement is written to be
// re-runnable (CREATE ... IF NOT EXISTS, CREATE OR REPLACE, DROP POLICY IF
// EXISTS before CREATE POLICY).
//
// Order is load bearing. Postgres validates a function body against the catalog
// at CREATE time, so functions naming a table must run after the tables, and
// policies calling a function must run after the functions.
//
//   DATABASE_URL=postgres://... node scripts/apply-schema.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_DIR = path.join(ROOT, "db", "schema");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const files = fs
  .readdirSync(SCHEMA_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

if (files.length === 0) {
  console.error(`No .sql files in ${SCHEMA_DIR}. Refusing to report success on nothing.`);
  process.exit(1);
}

const sql = postgres(url, { max: 1, onnotice: () => {} });

try {
  for (const file of files) {
    const text = fs.readFileSync(path.join(SCHEMA_DIR, file), "utf-8");
    process.stderr.write(`applying ${file} ... `);
    await sql.unsafe(text);
    process.stderr.write("ok\n");
  }
  console.error(`applied ${files.length} file(s)`);
} catch (err) {
  process.stderr.write("FAILED\n");
  console.error(String(err?.message ?? err));
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
