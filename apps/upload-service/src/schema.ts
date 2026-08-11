import { sql } from "./db";

// One-shot schema creation. Run with:
//   npm run build && node --env-file=.env dist/schema.js
async function main() {
  await sql`
    CREATE TABLE IF NOT EXISTS deployments (
      id            TEXT PRIMARY KEY,
      repo_url      TEXT NOT NULL,
      state         TEXT NOT NULL CHECK (state IN ('queued','building','deployed','failed')),
      error_message TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      building_at   TIMESTAMPTZ,
      finished_at   TIMESTAMPTZ
    )
  `;

  // Added after the table shipped, so it is a separate idempotent ALTER rather than
  // part of the CREATE above — an existing database would never re-run the CREATE.
  // NULL means "no screenshot"; the value is when it was captured.
  await sql`
    ALTER TABLE deployments
      ADD COLUMN IF NOT EXISTS screenshot_at TIMESTAMPTZ
  `;

  // Ownership. References Better Auth's "user" table, which lives in this same
  // database — so a deployment can never point at a user that does not exist, and
  // deleting a user takes their deployments with them.
  //
  // Nullable on purpose: rows created before this column existed have no owner, and
  // the backfill below is the only thing that assigns them.
  await sql`
    ALTER TABLE deployments
      ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES "user"("id") ON DELETE CASCADE
  `;

  // One-time backfill for the single-user era. Every read is about to filter on
  // user_id, so pre-existing deployments would silently vanish from the dashboard.
  // Guarded on there being exactly ONE account: with zero or several, there is no
  // correct owner to guess and this does nothing.
  const owners = await sql`SELECT id FROM "user" LIMIT 2`;
  if (owners.length === 1) {
    const adopted = await sql`
      UPDATE deployments SET user_id = ${owners[0].id}
       WHERE user_id IS NULL
       RETURNING id
    `;
    if (adopted.length > 0) {
      console.log(`backfilled ${adopted.length} pre-existing deployment(s) to the only account`);
    }
  }

  // The dashboard's main query, now scoped per user: that user's newest first.
  // An unindexed user_id filter on a growing table is a day-one ceiling.
  await sql`
    CREATE INDEX IF NOT EXISTS deployments_user_recent
      ON deployments (user_id, created_at DESC)
  `;

  // Kept for any query that still scans across all users (admin, reaper sweeps).
  await sql`
    CREATE INDEX IF NOT EXISTS deployments_created_desc
      ON deployments (created_at DESC)
  `;

  // The reaper's query: builds stuck in 'building'. Partial — only rare rows are indexed.
  await sql`
    CREATE INDEX IF NOT EXISTS deployments_stuck
      ON deployments (building_at)
      WHERE state = 'building'
  `;

  const rows = await sql`
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_name = 'deployments' ORDER BY ordinal_position
  `;
  console.log("deployments table ready:");
  for (const r of rows) console.log(`   ${String(r.column_name).padEnd(14)} ${r.data_type}`);
}

main().catch((e) => {
  console.error("schema failed:", e.message);
  process.exit(1);
});
