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

  // The dashboard's main query: newest deployments first.
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
