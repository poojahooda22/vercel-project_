import fs from "fs";
import path from "path";

// Framework defaults. Vite emits dist/, Create React App emits build/,
// a Next static export emits out/. (general knowledge)
const CANDIDATES = ["dist", "build", "out"];

export interface PublishPlan {
  /** Absolute path to the directory whose contents become the site. */
  publishDir: string;
  /** False when the repo is already static and needs no npm at all. */
  needsBuild: boolean;
  reason: string;
}

/**
 * Decides what to publish BEFORE any npm command runs.
 *
 * The package.json check is not a convenience: without one, npm walks UP the
 * directory tree and finds the deploy service's own manifest, so `npm install`
 * would run against this service and `npm run build` would rebuild the worker
 * instead of the user's site. Skipping npm entirely for static repos closes that.
 */
export function planBuild(repoDir: string): PublishPlan {
  if (!fs.existsSync(path.join(repoDir, "package.json"))) {
    // The static path is for plain-HTML repos, and index.html at the root is
    // what makes one servable. Without this check a repo that merely lacks a
    // package.json — a backend, a monorepo, a docs repo — gets its entire tree
    // uploaded and marked deployed, and the visitor's first request 404s: a
    // green deployment nobody can open. Refusing here turns that silent
    // publish-nothing into an honest failure on the card.
    if (!fs.existsSync(path.join(repoDir, "index.html"))) {
      throw new Error(
        "no package.json and no index.html at the repo root — nothing servable. " +
          "Deploy a static site (index.html) or a buildable frontend " +
          "(npm run build emitting dist/, build/ or out/).",
      );
    }
    return {
      publishDir: repoDir,
      needsBuild: false,
      reason: "no package.json — publishing the repo as a static site",
    };
  }
  return {
    publishDir: "",
    needsBuild: true,
    reason: "package.json found — running npm install && npm run build",
  };
}

/**
 * Finds the build output after a successful build. Throws rather than publishing
 * nothing, so an unrecognised framework fails visibly instead of deploying an
 * empty site.
 */
export function resolvePublishDir(repoDir: string): string {
  for (const name of CANDIDATES) {
    const candidate = path.join(repoDir, name);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }
  if (fs.existsSync(path.join(repoDir, ".next"))) {
    throw new Error(
      "build produced .next/ — Next.js needs a server runtime. Use `next export` " +
        "or a static framework; this platform serves static files only."
    );
  }
  throw new Error(
    `build finished but produced none of: ${CANDIDATES.join(", ")}. ` +
      "Check the repo's build script and its output directory."
  );
}
