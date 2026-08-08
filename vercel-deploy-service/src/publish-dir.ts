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
