import express from "express";
import { neon } from "@neondatabase/serverless";
import { contentTypeFor } from "./mime";
import { createS3Client, required, s3Bucket } from "@vercel-clone/shared";

const app = express();

export const BUCKET = s3Bucket();

const s3 = createS3Client();
const sql = neon(required("NEON_DB"));

interface Fetched {
  body: Buffer;
  key: string;
}

// Returns null for a missing object; throws for anything else, so "not found"
// and "the store is broken" stay distinguishable.
async function fetchObject(key: string): Promise<Fetched | null> {
  try {
    const obj = await s3.getObject({ Bucket: BUCKET, Key: key });
    if (!obj.Body) return null;
    return { body: Buffer.from(await obj.Body.transformToByteArray()), key };
  } catch (e) {
    const name = (e as { name?: string }).name;
    const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (name === "NoSuchKey" || name === "NotFound" || status === 404) return null;
    throw e;
  }
}

// A SPA owns its client-side routes, so /about must serve the shell. But an asset
// that 404s must stay a 404 — returning HTML with status 200 turns a broken script
// tag into a confusing MIME error instead of a visible missing file.
function wantsSpaShell(req: express.Request, filePath: string): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  if (!(req.headers.accept ?? "").includes("text/html")) return false;
  const lastSegment = filePath.split("/").pop() ?? "";
  return !lastSegment.includes(".");
}

/**
 * Which deployment a hostname serves.
 *
 * Two kinds of hostname share the wildcard. `{slug}.domain` is a project's
 * production URL: a pointer that promote and rollback move, so its answer must be
 * re-read and its pages must not be cached as permanent. `{id}.domain` is one
 * deployment, frozen forever, so everything under it may be cached for a year.
 * A label is tried as a slug first (slug creation refuses labels that equal a
 * deployment id, and id creation refuses ids that equal a slug), then taken as
 * an id.
 *
 * Hostnames are case-insensitive, so the label is lower-cased, and only a label
 * that could be a slug or an id ever reaches the database.
 *
 * The cache separates recency from freshness. Every entry carries the moment it
 * expires, fixed when it was written: a hit moves the entry to the recent end of
 * the map but never extends its life, so a pointer flip is visible within
 * HIT_TTL_MS however busy the site is — the "takes effect within seconds" that
 * rollback promises. "Not a slug" is cached longer: a deployment id never changes
 * meaning, and a brand-new slug's first build takes longer than that anyway. The
 * map is bounded (wildcard DNS makes every label reachable, so an unbounded map
 * would let a scan of random hostnames grow the process without limit): an LRU
 * capped at SLUG_CACHE_MAX, swept of expired entries on a timer. Concurrent
 * misses for one label share one lookup.
 *
 * The database is not on the critical path of serving. An expired entry is
 * served at once and refreshed in the background (stale-while-revalidate), so
 * only a label never seen by this process waits on a lookup. A lookup is aborted
 * after DB_TIMEOUT_MS; when it fails, the last known answer is kept, and with
 * none the label is tried as a deployment id — so id hosts depend on the bucket
 * alone, as they did before projects existed. Either outcome is cached for
 * FAIL_TTL_MS, so an outage costs one background probe per label per window and
 * no request-path stall. `degraded` marks the fall-through, so a miss is
 * answered as "temporarily unavailable" rather than a confident 404.
 */
const LABEL_RE = /^[a-z0-9-]{1,63}$/;
const HIT_TTL_MS = 15_000;
const MISS_TTL_MS = 60_000;
const FAIL_TTL_MS = 5_000;
const SLUG_CACHE_MAX = 10_000;
const DB_TIMEOUT_MS = 3_000;

interface Resolved {
  id: string | null;
  immutable: boolean;
  degraded?: boolean;
}
interface Entry {
  value: Resolved;
  expiresAt: number;
}
const slugCache = new Map<string, Entry>();
const pending = new Map<string, Promise<Resolved>>();

// Re-inserting moves the key to the end: Map iterates in insertion order, so the
// first key is always the least recently used and is the one evicted.
function touch(label: string, entry: Entry): void {
  slugCache.delete(label);
  slugCache.set(label, entry);
}

function remember(label: string, value: Resolved, ttlMs: number): void {
  touch(label, { value, expiresAt: Date.now() + ttlMs });
  if (slugCache.size > SLUG_CACHE_MAX) {
    const oldest = slugCache.keys().next().value;
    if (oldest !== undefined) slugCache.delete(oldest);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [label, entry] of slugCache) if (entry.expiresAt <= now) slugCache.delete(label);
}, 60_000).unref();

function asId(label: string): Resolved {
  return { id: label, immutable: true };
}

async function lookup(label: string): Promise<Resolved> {
  const rows = await sql.query(
    "SELECT production_deployment_id FROM projects WHERE slug = $1",
    [label],
    { fetchOptions: { signal: AbortSignal.timeout(DB_TIMEOUT_MS) } }
  );
  const row = rows[0] as { production_deployment_id: string | null } | undefined;
  return row ? { id: row.production_deployment_id ?? null, immutable: false } : asId(label);
}

async function resolve(label: string): Promise<Resolved> {
  const hit = slugCache.get(label);
  if (hit) {
    touch(label, hit);
    // Expired: answer with what is known and refresh behind the response. A
    // pointer flip is then visible within HIT_TTL_MS plus one request.
    if (hit.expiresAt <= Date.now()) void refresh(label, hit);
    return hit.value;
  }
  return refresh(label, null);
}

function refresh(label: string, hit: Entry | null): Promise<Resolved> {
  const inFlight = pending.get(label);
  if (inFlight) return inFlight;

  const work = (async () => {
    try {
      const value = await lookup(label);
      remember(label, value, value.immutable ? MISS_TTL_MS : HIT_TTL_MS);
      return value;
    } catch (e) {
      console.error(
        `resolve ${label}: database failed; ${hit ? "serving the last known answer" : "trying the label as a deployment id"}:`,
        e instanceof Error ? e.message : e
      );
      const value: Resolved = hit ? hit.value : { ...asId(label), degraded: true };
      remember(label, value, FAIL_TTL_MS);
      return value;
    } finally {
      pending.delete(label);
    }
  })();
  pending.set(label, work);
  return work;
}

// A probe arrives with Host set to the container name, an IP, or localhost —
// never a site's hostname. Under a site's hostname the path belongs to the site.
app.get("/healthz", (req, res, next) => {
  const host = req.hostname.toLowerCase();
  const probe = !host.includes(".") || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":");
  if (!probe) {
    next();
    return;
  }
  res.type("text/plain").send("ok");
});

// Express 5 needs a NAMED wildcard, and the braces make it match zero segments too:
// "/*splat" alone does NOT match "/", which sends the site root to Express's 404.
app.get("/{*splat}", async (req, res) => {
  const label = req.hostname.toLowerCase().split(".")[0];

  // The root is not a fallback case: "dist/{id}/" matches no object because the
  // keyspace is flat and has no directory entries.
  const filePath = req.path === "/" ? "/index.html" : req.path;

  if (filePath.includes("..")) {
    res.status(400).send("Bad request");
    return;
  }
  // Neither a slug nor an id can look like this; no lookup, no cache entry.
  if (!LABEL_RE.test(label)) {
    res.status(404).send("Not found");
    return;
  }

  try {
    const target = await resolve(label);
    if (!target.id) {
      res.status(404).send("This project has no production deployment yet.");
      return;
    }
    const id = target.id;

    let found = await fetchObject(`dist/${id}${filePath}`);
    let servedPath = filePath;

    if (!found && wantsSpaShell(req, filePath)) {
      found = await fetchObject(`dist/${id}/index.html`);
      servedPath = "/index.html";
    }

    if (!found) {
      // Without the database this label may have been a slug, not an id: the
      // honest answer is "not right now", not "does not exist".
      if (target.degraded) {
        res.set("Retry-After", "10");
        res.status(503).send("Temporarily unavailable");
        return;
      }
      res.status(404).send("Not found");
      return;
    }

    res.set("Content-Type", contentTypeFor(servedPath));
    // Safe only now that the map above is correct: it stops the browser
    // second-guessing a type we got right.
    res.set("X-Content-Type-Options", "nosniff");
    // Which deployment answered: under a project's hostname this is the pointer
    // as resolved for this response, which is what a rollback check reads.
    res.set("X-Deployment-Id", id);
    // A deployment's files never change under its own hostname, so they may be
    // cached for as long as HTTP allows; under a project's hostname the same file
    // can be replaced by a promote, so the browser must ask again each time.
    res.set(
      "Cache-Control",
      target.immutable ? "public, max-age=31536000, immutable" : "no-cache"
    );
    res.send(found.body);
  } catch (e) {
    // A broken bucket is not a missing page — say so, and log enough to debug.
    console.error(`502 serving ${label}${filePath}:`, e instanceof Error ? e.message : e);
    res.status(502).send("Upstream storage error");
  }
});

app.listen(3001, () => console.log("request handler listening on http://localhost:3001"));
