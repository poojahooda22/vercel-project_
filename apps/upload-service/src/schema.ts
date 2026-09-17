import { findOrCreateProject, sql } from "./db";

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

  // Projects: one repository, many deployments, one production pointer. The
  // pointer references a deployment and clears itself if that row is deleted;
  // deployments cascade with their project. The slug is the production hostname
  // label and is unique across the platform.
  await sql`
    CREATE TABLE IF NOT EXISTS projects (
      id                       TEXT PRIMARY KEY,
      user_id                  TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      name                     TEXT NOT NULL,
      slug                     TEXT NOT NULL UNIQUE,
      repo_url                 TEXT NOT NULL,
      repo_full_name           TEXT,
      installation_id          BIGINT,
      production_branch        TEXT,
      production_deployment_id TEXT REFERENCES deployments(id) ON DELETE SET NULL,
      created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, repo_url)
    )
  `;
  // The push receiver's lookup: which projects follow this repository.
  await sql`
    CREATE INDEX IF NOT EXISTS projects_repo
      ON projects (lower(repo_full_name))
  `;
  // The production pointer: unique (a deployment is production of at most one
  // project) and, through the same index, fast to look up — every DELETE on
  // deployments fires the pointer's ON DELETE SET NULL action, which would
  // otherwise scan the projects table inside the deleting transaction.
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS projects_production_deployment
      ON projects (production_deployment_id)
      WHERE production_deployment_id IS NOT NULL
  `;
  await sql`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS project_id TEXT REFERENCES projects(id) ON DELETE CASCADE`;
  await sql`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS git_ref TEXT`;
  await sql`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS trigger TEXT`;
  // Two more states: 'canceled' (a queued deployment superseded by a newer push)
  // and 'ingesting' (claimed by the ingest loop, so a cancel cannot land on a
  // clone in progress and a reaper can tell a live ingest from a lost pop).
  await sql`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS ingesting_at TIMESTAMPTZ`;
  await sql`ALTER TABLE deployments DROP CONSTRAINT IF EXISTS deployments_state_check`;
  await sql`
    ALTER TABLE deployments
      ADD CONSTRAINT deployments_state_check
      CHECK (state IN ('queued','ingesting','building','deployed','failed','canceled'))
  `;
  // The reaper's other query: ingests that never finished. Partial, like deployments_stuck.
  await sql`
    CREATE INDEX IF NOT EXISTS deployments_ingesting
      ON deployments (ingesting_at)
      WHERE state = 'ingesting'
  `;
  // A rollback switches automatic promotion off until a newer build is promoted by hand.
  await sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS auto_promote BOOLEAN NOT NULL DEFAULT true`;
  // The project page's query: a project's deployments, newest first.
  await sql`
    CREATE INDEX IF NOT EXISTS deployments_project_recent
      ON deployments (project_id, created_at DESC)
  `;
  // Every deployment belongs to a project. The backfill below adopts rows from
  // before projects existed; once none are left the column is made NOT NULL, so
  // the invariant is the database's, not a comment's.
  const orphanCount = Number((await sql`SELECT count(*) AS n FROM deployments WHERE project_id IS NULL`)[0].n);
  if (orphanCount === 0) {
    await sql`ALTER TABLE deployments ALTER COLUMN project_id SET NOT NULL`;
    // A project can only point at one of ITS OWN deployments: the pointer is a
    // composite foreign key on (project id, deployment id), so no writer — a
    // future feature, a backfill, an admin script — can ever point a project at
    // another project's deployment. Deleting the deployment clears the pointer
    // column alone (PostgreSQL 15+ can SET NULL a subset of a composite key),
    // which replaces the single-column FK the table shipped with.
    await sql`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deployments_project_id_id_key') THEN
          ALTER TABLE deployments ADD CONSTRAINT deployments_project_id_id_key UNIQUE (project_id, id);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_production_same_project') THEN
          ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_production_deployment_id_fkey;
          ALTER TABLE projects ADD CONSTRAINT projects_production_same_project
            FOREIGN KEY (id, production_deployment_id) REFERENCES deployments (project_id, id)
            ON DELETE SET NULL (production_deployment_id);
        END IF;
      END $$
    `;
  }
  // The per-account backlog bound counts rows waiting for or inside the ingest
  // loop; partial, so the count is over pending rows, not the account's history.
  await sql`
    CREATE INDEX IF NOT EXISTS deployments_pending
      ON deployments (user_id)
      WHERE state IN ('queued', 'ingesting')
  `;

  // Backfill: every deployment from before projects existed joins a project for
  // its (owner, repository), and the newest deployed one becomes that project's
  // production. Idempotent — rows that already have a project are untouched.
  const orphans = await sql`
    SELECT user_id, repo_url,
           max(repo_full_name) AS repo_full_name,
           max(installation_id) AS installation_id
      FROM deployments
     WHERE project_id IS NULL AND user_id IS NOT NULL
     GROUP BY user_id, repo_url
  `;
  for (const o of orphans) {
    const project = await findOrCreateProject({
      userId: String(o.user_id),
      name: String(o.repo_url).replace(/\/+$/, "").split("/").pop() ?? "site",
      repoUrl: String(o.repo_url),
      repoFullName: (o.repo_full_name as string | null) ?? null,
      installationId: o.installation_id == null ? null : Number(o.installation_id),
    });
    await sql`
      UPDATE deployments SET project_id = ${project.id}, trigger = COALESCE(trigger, 'manual')
       WHERE user_id = ${o.user_id} AND repo_url = ${o.repo_url} AND project_id IS NULL
    `;
    await sql`
      UPDATE projects p SET production_deployment_id = (
        SELECT id FROM deployments d
         WHERE d.project_id = p.id AND d.state = 'deployed'
         ORDER BY d.created_at DESC LIMIT 1
      )
      WHERE p.id = ${project.id} AND p.production_deployment_id IS NULL
    `;
    console.log(`backfilled project ${project.slug} for ${o.repo_url}`);
  }

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
