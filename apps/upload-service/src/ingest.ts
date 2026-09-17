import fs from "fs";
import path from "path";
import { deletePrefix, uploadFile } from "./aws";
import {
  BUILD_QUEUE,
  GithubApiError,
  INGEST_QUEUE,
  createInstallationToken,
  createRedisClient,
  getAppInstallation,
  gitAuthConfig,
  githubAppConfig,
  type Deployment,
  type GithubAppConfig,
  type Project,
} from "@vercel-clone/shared";
import {
  CloneError,
  CloneTimeoutError,
  EmptyRepoError,
  GitUnavailableError,
  RepoUnreadableError,
  TEMP_ROOT,
  cloneRepo,
  ensureTempRoot,
  mapPool,
  objectKey,
  walkTree,
  type GitConfigPair,
} from "./clone";
import {
  claimForIngest,
  deleteInstallation,
  failQueued,
  getInstallation,
  peekQueued,
  recordClone,
  setProductionBranch,
  stageForBuild,
} from "./db";

/**
 * The ingest worker: turns a queued deployment into a staged tree in the bucket
 * and hands it to the build queue.
 *
 * It runs inside the upload service (which already holds the App credentials and
 * the clone module) as a loop over the ingest queue, so no HTTP request ever waits
 * on a clone: the dashboard's deploy and GitHub's push both just enqueue and answer.
 * GitHub requires that answer within ten seconds, which is the reason this exists.
 *
 * Bounds, Tier B on one box, with the arithmetic behind each number:
 *   - at most MAX_IN_FLIGHT jobs run at once, and at most MAX_IN_FLIGHT_PER_USER of
 *     them belong to one account, so one signed-in account cannot hold every slot
 *   - a clone is stopped past CLONE_WALL_CLOCK_MS, after CLONE_INACTIVITY_MS of
 *     silence, or as soon as a two-second watchdog sees the checkout pass
 *     MAX_REPO_FILES entries or 2 × MAX_REPO_BYTES counting the pack, or the temp
 *     volume drop below MIN_FREE_DISK — so scratch stays near MAX_IN_FLIGHT × 2 ×
 *     MAX_REPO_BYTES plus one two-second write window per clone
 *   - uploads stream UPLOAD_POOL files at a time under one UPLOAD_WALL_CLOCK_MS
 *     deadline; the first failure cancels the rest and removes the partial upload
 *   - the loop stops taking jobs while the temp volume is below MIN_FREE_DISK
 * What breaks at the next tier: the bounds are per process. N instances need a
 * shared admission counter, and a quota-limited scratch filesystem is the real
 * answer to a repository that writes faster than any watchdog reads.
 *
 * States: the loop claims a row queued -> ingesting before any work, so a newer
 * push cannot cancel a clone in progress, and every write on the way is guarded on
 * that claim. Once the tree is staged the row goes back to queued for a build
 * worker, cancelable again until one claims it.
 *
 * Delivery is at-most-once: a job popped from the queue and lost to a crash leaves
 * its row 'queued' or 'ingesting' until the reaper marks it failed. That is the
 * accepted Phase 8 gap, named here so it is not mistaken for a guarantee. A
 * database error BEFORE the claim is not that gap: the id goes back on the queue
 * and the loop backs off. A claim whose UPDATE committed but whose answer was lost
 * leaves the row 'ingesting' with no owner — that one is the reaper's, like a
 * crash, which is what the deployments_ingesting index exists for.
 */
export const CLONE_WALL_CLOCK_MS = 5 * 60_000;
export const CLONE_INACTIVITY_MS = 60_000;
export const UPLOAD_WALL_CLOCK_MS = 10 * 60_000;
export const MAX_REPO_BYTES = 512 * 1024 * 1024;
export const MAX_REPO_FILES = 20_000;
export const MAX_IN_FLIGHT = 4;
export const MAX_IN_FLIGHT_PER_USER = 2;
export const MIN_FREE_DISK = 2 * 1024 * 1024 * 1024;
export const UPLOAD_POOL = 8;

// What the row says when the clone cannot read the repository. Never git's own
// text: it names container paths, and anonymously "private" and "does not exist"
// are the same answer, so the message must not claim to know which.
export const REPO_UNREADABLE =
  "We can't read this repository: it is private, or the URL is wrong. " +
  "Private repositories deploy through Connect GitHub.";
export const INSTALLATION_REMOVED =
  "Your GitHub installation was removed on GitHub. Connect GitHub again to pick repositories.";
export const INSTALLATION_SUSPENDED =
  "Your GitHub installation is suspended on GitHub, so its repositories cannot be read.";

let inFlight = 0;
const inFlightByUser = new Map<string, number>();
// Scratch directories of jobs in progress: housekeeping must never touch these.
export const liveDirs = new Set<string>();

export function inFlightCount(): number {
  return inFlight;
}

export async function freeDiskBytes(): Promise<number> {
  await ensureTempRoot();
  const s = await fs.promises.statfs(TEMP_ROOT);
  return Number(s.bavail) * Number(s.bsize);
}

/** git's last "fatal:" line, or the whole text when there is none. For logs only. */
function lastFatalLine(stderr: string): string {
  const fatal = stderr.split("\n").filter((l) => l.startsWith("fatal:"));
  return (fatal[fatal.length - 1] ?? stderr).trim();
}

/**
 * A one-hour token scoped to the project's one repository, or the sentence to
 * fail the deployment with when the installation no longer serves.
 */
async function repoToken(
  cfg: GithubAppConfig,
  installationId: number,
  userId: string,
  repoName: string
): Promise<{ config: GitConfigPair[] } | { failure: string }> {
  // The installation must still belong to this project's owner.
  if (!(await getInstallation(installationId, userId))) return { failure: INSTALLATION_REMOVED };
  try {
    const { token } = await createInstallationToken(cfg, installationId, {
      repositories: [repoName],
      permissions: { contents: "read" },
    });
    return { config: [gitAuthConfig(token)] };
  } catch (e) {
    if (e instanceof GithubApiError && !e.rateLimited) {
      if (e.status === 404) {
        await deleteInstallation(installationId, userId);
        return { failure: INSTALLATION_REMOVED };
      }
      if (e.status === 403) {
        try {
          const live = await getAppInstallation(cfg, installationId);
          if (live.suspended_at) {
            await deleteInstallation(installationId, userId);
            return { failure: INSTALLATION_SUSPENDED };
          }
        } catch (inner) {
          if (inner instanceof GithubApiError && inner.status === 404) {
            await deleteInstallation(installationId, userId);
            return { failure: INSTALLATION_REMOVED };
          }
        }
      }
      if (e.status === 422) {
        return { failure: "That repository is not part of your GitHub installation. Add it on GitHub and try again." };
      }
    }
    console.error("ingest: token mint failed:", e instanceof Error ? e.message : e);
    return { failure: "GitHub did not answer while requesting access to the repository; try again." };
  }
}

/** Removes what an ingest staged for a deployment that will never build. Best effort, logged. */
async function sweepStaged(id: string): Promise<void> {
  try {
    const n = await deletePrefix(`output/${id}/`);
    if (n > 0) console.log(`ingest ${id}: swept ${n} staged object(s)`);
  } catch (e) {
    console.error(`ingest ${id}: could not sweep staged objects:`, e instanceof Error ? e.message : e);
  }
}

/** A claimed deployment and its project, as the loop hands it to runIngest. */
export interface IngestJob {
  deployment: Deployment;
  project: Project;
}

/**
 * Runs one claimed deployment through clone → stage → build queue. Never throws:
 * every statement runs inside the try, and the catch turns whatever escaped into
 * a failed row and a log line, because the caller runs this detached and an
 * unhandled rejection would take the whole service down.
 */
export async function runIngest(job: IngestJob, publisher: ReturnType<typeof createRedisClient>): Promise<void> {
  const { deployment, project } = job;
  const id = deployment.id;
  let dir: string | null = null;
  try {
    let gitConfig: GitConfigPair[] = [];
    if (project.installation_id !== null && project.repo_full_name) {
      const cfg = githubAppConfig();
      if (!cfg) {
        await failQueued(id, "GitHub App not configured on this server");
        return;
      }
      const got = await repoToken(cfg, project.installation_id, project.user_id, project.repo_full_name.split("/")[1]);
      if ("failure" in got) {
        await failQueued(id, got.failure);
        return;
      }
      gitConfig = got.config;
    }

    dir = await fs.promises.mkdtemp(path.join(TEMP_ROOT, "deploy-"));
    liveDirs.add(dir);
    const home = path.join(dir, "home");
    const repoDir = path.join(dir, "repo");
    await fs.promises.mkdir(home);

    let sha: string;
    let ref: string;
    try {
      // A push names the branch it is for; a manual deploy follows the remote's
      // HEAD, which is the repository's default branch as it is NOW.
      ({ sha, ref } = await cloneRepo(`${project.repo_url}.git`, repoDir, {
        config: gitConfig,
        home,
        branch: deployment.git_ref ?? undefined,
        wallClockMs: CLONE_WALL_CLOCK_MS,
        inactivityMs: CLONE_INACTIVITY_MS,
        caps: {
          maxFiles: MAX_REPO_FILES,
          maxBytes: MAX_REPO_BYTES,
          lowDisk: async () => (await freeDiskBytes()) < MIN_FREE_DISK,
        },
      }));
    } catch (e) {
      // Each failure has a fixed sentence for the row; git's own text goes to the log only.
      let message: string;
      if (e instanceof RepoUnreadableError) {
        message = project.installation_id
          ? `GitHub refused access to ${project.repo_full_name} through your installation. ` +
            "Check on GitHub that the app still has access to this repository."
          : REPO_UNREADABLE;
        console.error(`ingest ${id}: repository unreadable — ${lastFatalLine(e.stderr)}`);
      } else if (e instanceof CloneTimeoutError) {
        message =
          e.kind === "size"
            ? `This repository is larger than ${MAX_REPO_BYTES / 1048576} MB, which is more than this platform builds.`
            : e.kind === "files"
              ? `This repository has more than ${MAX_REPO_FILES} files, which is more than this platform builds.`
              : e.kind === "disk"
                ? "The server ran low on disk during the clone; try again later."
                : "Cloning took too long and was stopped.";
        console.error(`ingest ${id}: clone stopped (${e.kind})`);
      } else if (e instanceof EmptyRepoError) {
        message = "This repository has no commits yet.";
      } else if (e instanceof CloneError && /Remote branch .* not found/.test(e.stderr)) {
        // A push for a branch that was renamed or deleted before this ran.
        message = `The branch ${deployment.git_ref ?? ""} no longer exists on the repository.`.replace("  ", " ");
        console.error(`ingest ${id}: branch gone — ${lastFatalLine(e.stderr)}`);
      } else if (e instanceof GitUnavailableError) {
        message = "internal error";
        console.error(`ingest ${id}: ${e.message}`);
      } else {
        message = "git clone failed";
        const stderr = e instanceof CloneError ? e.stderr : e instanceof Error ? e.message : String(e);
        console.error(`ingest ${id}: git clone failed\n${stderr}`);
      }
      await failQueued(id, message);
      return;
    }
    // Guarded on the claim: a row deleted during the clone must not be staged.
    if (!(await recordClone(id, sha, ref))) {
      console.log(`ingest ${id}: deleted during the clone; stopped`);
      return;
    }
    // The branch this clone landed on is the repository's default branch as of
    // now: the project's production branch follows it.
    if (project.production_branch !== ref) await setProductionBranch(project.id, ref);

    const tree = await walkTree(repoDir, { maxFiles: MAX_REPO_FILES, maxBytes: MAX_REPO_BYTES });
    // The walker excludes the repository's own store; a path with a .git segment in
    // the artifact set would mean that filter broke, and it must not reach the bucket.
    if (tree.files.some((f) => path.relative(repoDir, f).split(path.sep).includes(".git"))) {
      throw new Error("a .git path survived the artifact walk");
    }
    if (tree.over) {
      await failQueued(
        id,
        tree.over === "files"
          ? `This repository has more than ${MAX_REPO_FILES} files; the limit is ${MAX_REPO_FILES}.`
          : `This repository is larger than ${MAX_REPO_BYTES / 1048576} MB after checkout; the limit is ${MAX_REPO_BYTES / 1048576} MB.`
      );
      return;
    }

    // One deadline for the whole upload phase; the pool cancels every in-flight PUT
    // on the first failure, and a failed deploy leaves no objects behind.
    const deadline = AbortSignal.timeout(UPLOAD_WALL_CLOCK_MS);
    try {
      await mapPool(tree.files, UPLOAD_POOL, (file, signal) => uploadFile(objectKey(id, repoDir, file), file, signal), deadline);
    } catch (e) {
      const message = deadline.aborted ? "Uploading took too long and was stopped." : "upload to storage failed";
      console.error(`ingest ${id}: ${message}:`, e instanceof Error ? e.message : e);
      await failQueued(id, message);
      await sweepStaged(id);
      return;
    }

    // Enqueue only after every file is durably in the bucket: the queue message is
    // a pointer, and publishing it early makes the worker build a partial tree.
    // The row goes back to 'queued' first (it now waits for a worker, and may be
    // superseded again); a row that vanished during the upload leaves no objects.
    if (!(await stageForBuild(id))) {
      console.log(`ingest ${id}: deleted during the upload; stopped`);
      await sweepStaged(id);
      return;
    }
    try {
      await publisher.lPush(BUILD_QUEUE, id);
    } catch (e) {
      // A fixed sentence on the row; the reason (which names internal hosts) goes to the log.
      console.error(`ingest ${id}: could not enqueue the build:`, e instanceof Error ? e.message : e);
      await failQueued(id, "The build could not be queued; try again.");
      await sweepStaged(id);
      return;
    }
    console.log(`ingest ${id}: staged ${tree.files.length} files (${Math.round(tree.bytes / 1024)} KB) at ${sha.slice(0, 7)} on ${ref}`);
  } catch (e) {
    console.error(`ingest ${id}: internal error:`, e instanceof Error ? e.stack ?? e.message : e);
    await failQueued(id, "internal error").catch((inner) =>
      console.error(`ingest ${id}: could not record the failure either:`, inner instanceof Error ? inner.message : inner)
    );
  } finally {
    if (dir) {
      liveDirs.delete(dir);
      try {
        await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3 });
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code ?? (e instanceof Error ? e.message : e);
        console.error(`ingest ${id}: temp dir not removed (${code}); housekeeping will reclaim it`);
      }
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The loop. One blocking pop at a time; each job runs detached under the in-flight
 * caps, and the loop waits when the caps or the disk floor say so. The blocking
 * client is dedicated: node-redis wants blocking commands on their own connection.
 */
export async function startIngestLoop(): Promise<void> {
  const consumer = createRedisClient("upload/ingest-consumer");
  const publisher = createRedisClient("upload/ingest-publisher");
  await consumer.connect();
  await publisher.connect();
  console.log("ingest loop waiting on ingest-queue");

  for (;;) {
    while (inFlight >= MAX_IN_FLIGHT) await sleep(500);
    try {
      while ((await freeDiskBytes()) < MIN_FREE_DISK) {
        console.error("ingest loop: temp volume below the free-disk floor; waiting");
        await sleep(30_000);
      }
    } catch (e) {
      console.error("ingest loop: could not read free disk:", e instanceof Error ? e.message : e);
      await sleep(30_000);
      continue;
    }

    let id: string | undefined;
    try {
      id = (await consumer.brPop(INGEST_QUEUE, 0))?.element;
    } catch (e) {
      console.error("ingest loop: pop failed:", e instanceof Error ? e.message : e);
      await sleep(5_000);
      continue;
    }
    if (!id) continue;

    // The id is in hand and nothing else holds it: a database error here must put
    // it back, not drop it, or the row would stay queued with no one to run it.
    const requeue = () =>
      publisher.lPush(INGEST_QUEUE, id).catch((e) =>
        console.error(`ingest ${id}: LOST — could not re-queue after a failure:`, e instanceof Error ? e.message : e)
      );

    let queued: { userId: string } | null;
    try {
      queued = await peekQueued(id);
    } catch (e) {
      console.error(`ingest ${id}: could not read the row; re-queued:`, e instanceof Error ? e.message : e);
      await requeue();
      await sleep(5_000);
      continue;
    }
    if (!queued) {
      console.log(`ingest ${id}: not queued any more; skipped`);
      continue;
    }
    const { userId } = queued;
    // Per-user fairness: a job past the per-user cap goes back to the end of the
    // queue rather than blocking everyone behind it.
    if ((inFlightByUser.get(userId) ?? 0) >= MAX_IN_FLIGHT_PER_USER) {
      await requeue();
      await sleep(1_000);
      continue;
    }

    let job: Awaited<ReturnType<typeof claimForIngest>>;
    try {
      job = await claimForIngest(id);
    } catch (e) {
      console.error(`ingest ${id}: could not claim the row; re-queued:`, e instanceof Error ? e.message : e);
      await requeue();
      await sleep(5_000);
      continue;
    }
    if (!job) {
      console.log(`ingest ${id}: not queued any more; skipped`);
      continue;
    }
    if (!job.project) {
      // Cannot happen for rows this service creates; a row without a project has
      // nothing to clone from and must not stay 'ingesting' forever.
      console.error(`ingest ${id}: no project for this deployment; failed`);
      await failQueued(id, "internal error").catch((e) =>
        console.error(`ingest ${id}: could not record the failure either:`, e instanceof Error ? e.message : e)
      );
      continue;
    }

    inFlight++;
    inFlightByUser.set(userId, (inFlightByUser.get(userId) ?? 0) + 1);
    void runIngest({ deployment: job.deployment, project: job.project }, publisher)
      .catch((e) => console.error(`ingest ${id}: escaped runIngest:`, e instanceof Error ? e.stack ?? e.message : e))
      .finally(() => {
        inFlight--;
        const left = (inFlightByUser.get(userId) ?? 1) - 1;
        if (left <= 0) inFlightByUser.delete(userId);
        else inFlightByUser.set(userId, left);
      });
  }
}
