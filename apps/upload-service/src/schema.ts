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

  // Build-time environment variables from the upload dialog: a JSONB object of
  // KEY -> value, injected only into that deployment's build. NULL means none.
  await sql`
    ALTER TABLE deployments
      ADD COLUMN IF NOT EXISTS build_env JSONB
  `;

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

  // GitHub App installations: which GitHub account's installation belongs to which
  // platform user. A row is written only after the callback (or the discovery pass)
  // proved the installation's GitHub account is the one the user signed in with.
  // Deployments reference this by id but not by foreign key: an installation can be
  // removed on GitHub after a deployment was made through it, and the deployment
  // must survive that.
  await sql`
    CREATE TABLE IF NOT EXISTS github_installations (
      installation_id      BIGINT PRIMARY KEY,
      user_id              TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      account_login        TEXT NOT NULL,
      account_type         TEXT NOT NULL,
      repository_selection TEXT NOT NULL,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS github_installations_user
      ON github_installations (user_id)
  `;

  // Where a deployment's source came from, and which commit was built. NULL for
  // public-URL deployments (first two) and for rows older than this column (third).
  await sql`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS installation_id BIGINT`;
  await sql`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS repo_full_name TEXT`;
  await sql`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS git_sha TEXT`;

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
