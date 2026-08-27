// First run.
//
//   DATABASE_URL=postgres://... node scripts/bootstrap.mjs you@example.com "Your Name"
//
// Creates the first user and puts them on the roster.
//
// The roster is the chicken-and-egg problem in this schema, and it is worth
// understanding rather than working around. app_add_hangar_member refuses a
// caller who is not already on the roster, so a fresh install can never add its
// first member through the application. It has to come from the operator, with
// the database credentials, exactly once. After that the roster adds itself.
//
// This connects as the migration role, not as hangar_app, because it writes
// rows the application deliberately cannot.

import { randomUUID, randomBytes } from "node:crypto";
import postgres from "postgres";

const [email, name] = process.argv.slice(2);

if (!email) {
  console.error("usage: node scripts/bootstrap.mjs <email> [name]");
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const sql = postgres(url, { max: 1, onnotice: () => {} });

try {
  const id = `u_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

  const [user] = await sql`
    INSERT INTO users (id, email, name)
    VALUES (${id}, ${email}, ${name ?? null})
    ON CONFLICT ((lower(email))) DO UPDATE SET name = COALESCE(EXCLUDED.name, users.name)
    RETURNING id, email, name
  `;

  await sql`
    INSERT INTO hangar_members (user_id) VALUES (${user.id})
    ON CONFLICT (user_id) DO NOTHING
  `;

  const [count] = await sql`SELECT count(*)::int AS n FROM hangar_members`;

  console.log("");
  console.log(`  user     ${user.email}${user.name ? ` (${user.name})` : ""}`);
  console.log(`  id       ${user.id}`);
  console.log(`  roster   ${count.n} member${count.n === 1 ? "" : "s"}`);
  console.log("");

  if (count.n === 1) {
    console.log("  Two secrets to set before starting the server:");
    console.log("");
    console.log(`    HANGAR_SESSION_SECRET=${randomBytes(32).toString("hex")}`);
    console.log(`    HANGAR_COMPANION_TOKEN=${randomBytes(32).toString("hex")}`);
    console.log("");
    console.log("  The companion token is a shared secret between the server and");
    console.log("  the companion process. Whoever holds it can post as the agent");
    console.log("  into any room, so treat it like a deploy key.");
    console.log("");
  }
} catch (err) {
  console.error(String(err?.message ?? err));
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
