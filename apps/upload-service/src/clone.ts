import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The git binary is the first thing that touches a stranger's input, so it runs
 * behind a fence rather than with the service's own environment, and it is spawned
 * directly with a fixed argument list rather than through a wrapper library.
 *
 * Why no wrapper: simple-git refuses a child environment carrying GIT_CONFIG_COUNT
 * unless an "unsafe" flag is set, and its debug logger prints the whole spawn
 * environment, header included. Neither is a problem the wrapper solves for us; the
 * argument list here is built only from values this module has already validated.
 *
 * What the fence does, and why each line exists:
 *   - The child sees ONLY the variables listed below. Without that, git inherits the
 *     storage keys and the database connection string.
 *   - HOME and USERPROFILE point at an empty directory owned by the deploy. On a
 *     developer machine the real home holds a .netrc and git config with a
 *     credential helper, either of which would silently authenticate an
 *     "anonymous" public clone with the developer's stored GitHub login, or open a
 *     GUI prompt and hang.
 *   - LC_ALL=C: the error classifier below anchors on git's English messages, so the
 *     host's locale must not translate them.
 *   - GIT_CONFIG_NOSYSTEM=1 and GIT_CONFIG_GLOBAL=/dev/null: git reads no config
 *     file but the clone's own. Measured on this Windows box: 31 file-sourced
 *     settings, credential.helper among them, drop to only the repository's own.
 *   - credential.helper= (an empty entry resets the helper list) and
 *     GCM_INTERACTIVE=never: belt and braces for the same hole.
 *   - GIT_TERMINAL_PROMPT=0: a repo git cannot read fails in a second with a stable
 *     message instead of waiting for a username on a terminal.
 *   - GIT_ALLOW_PROTOCOL=https and GIT_PROTOCOL_FROM_USER=0: git accepts file://,
 *     ssh:// and git:// by default; file:// would clone anything the service user
 *     can read.
 *   - http.lowSpeedLimit / http.lowSpeedTime: git aborts a transfer that stops
 *     entirely (under 1 byte/s) for the window (git-config(1)). This is what
 *     actually ends a stalled connection: killing the git process alone leaves its
 *     git-remote-https helper blocked in the network read. The threshold is one
 *     byte, not a kilobyte, because GitHub's server-side pack preparation sends
 *     only a trickle of progress bytes for a while on big repositories; liveness
 *     is judged by this module's own inactivity timer, whose window is shorter,
 *     so a stall is classified here and not as git's "curl 28".
 *   - Runtime config through GIT_CONFIG_COUNT/KEY_n/VALUE_n (git-config(1),
 *     ENVIRONMENT): overrides files, never touches disk or argv. The App token
 *     travels this way as an http.<url>.extraheader entry.
 */
const INHERITED_ENV_KEYS = [
  "PATH",
  // Git for Windows resolves through cmd.exe and its own temp and data paths.
  "SystemRoot",
  "ComSpec",
  "TEMP",
  "TMP",
  "APPDATA",
  "LOCALAPPDATA",
];

/** Every deploy's scratch space lives under one service-owned directory. */
export const TEMP_ROOT = path.join(os.tmpdir(), "vercel-clone-upload");

export async function ensureTempRoot(): Promise<string> {
  await fs.promises.mkdir(TEMP_ROOT, { recursive: true });
  return TEMP_ROOT;
}

export interface GitConfigPair {
  key: string;
  value: string;
}

export function gitEnv(
  config: GitConfigPair[] = [],
  opts: { home: string; lowSpeedTimeSec?: number }
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  const pairs: GitConfigPair[] = [
    { key: "credential.helper", value: "" },
    { key: "http.lowSpeedLimit", value: "1" },
    { key: "http.lowSpeedTime", value: String(opts.lowSpeedTimeSec ?? 75) },
    ...config,
  ];
  env.HOME = opts.home;
  env.USERPROFILE = opts.home;
  env.LC_ALL = "C";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_ALLOW_PROTOCOL = "https";
  env.GIT_PROTOCOL_FROM_USER = "0";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GCM_INTERACTIVE = "never";
  env.GIT_CONFIG_COUNT = String(pairs.length);
  pairs.forEach((p, i) => {
    env[`GIT_CONFIG_KEY_${i}`] = p.key;
    env[`GIT_CONFIG_VALUE_${i}`] = p.value;
  });
  return env;
}

/** GitHub answered with a login challenge or "not found": private, or the URL is wrong. */
export class RepoUnreadableError extends Error {
  constructor(public readonly stderr: string) {
    super("repository unreadable");
    this.name = "RepoUnreadableError";
  }
}

export type StopReason = "inactivity" | "wall-clock" | "size" | "files" | "disk";

/** Git was stopped: silent too long, over the wall clock, or the checkout grew past a cap. */
export class CloneTimeoutError extends Error {
  constructor(public readonly kind: StopReason) {
    super(`clone stopped (${kind})`);
    this.name = "CloneTimeoutError";
  }
}

/** The clone succeeded but the repository has no commits to build. */
export class EmptyRepoError extends Error {
  constructor() {
    super("repository is empty");
    this.name = "EmptyRepoError";
  }
}

/** git could not be started at all: a server problem, never the caller's. */
export class GitUnavailableError extends Error {
  constructor(cause: string) {
    super(`git could not be started: ${cause}`);
    this.name = "GitUnavailableError";
  }
}

/** Any other clone failure. `stderr` is for the server log, never for the client. */
export class CloneError extends Error {
  constructor(public readonly stderr: string) {
    super("git clone failed");
    this.name = "CloneError";
  }
}

// Failures GitHub produces, anonymously or with a token, for a repo the caller may
// not read. Anonymously, private and nonexistent are indistinguishable by design.
// Anchored on GitHub's own phrasings so a network error ("Could not resolve host")
// or a missing local file is never read as "private".
const UNREADABLE =
  /could not read Username|could not read Password|terminal prompts disabled|Authentication failed|remote: Repository not found|repository '[^']*' not found/i;

// git's own low-speed abort, when it wins the race against the inactivity timer.
// "timed out" alone is not matched: a connect-phase failure says that too.
const STALLED = /curl 28|Operation too slow/i;

// Only the tail of git's output is kept: progress lines from a large clone would
// otherwise grow without bound, and the useful line is always the last "fatal:".
const STDERR_KEEP = 64 * 1024;

interface GitRun {
  code: number;
  stdout: string;
  stderr: string;
  stopped: StopReason | null;
}

/**
 * Kills git AND its helpers. git clone forks git-remote-https, which inherits the
 * stderr pipe; killing only the parent leaves the helper alive in a network read
 * and the pipe open. Measured: with a plain kill, a clone against a stalled server
 * emitted 'exit' 3 ms after the signal and never 'close'.
 */
function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    }).on("error", () => child.kill("SIGKILL"));
  } else {
    // Spawned detached, so the pid is also its process group.
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

interface RunOptions {
  env: Record<string, string>;
  cwd?: string;
  wallClockMs: number;
  inactivityMs: number;
  /**
   * Polled while the process runs; a returned reason stops it. Asynchronous and
   * never overlapped: the next poll starts `tickMs` after the previous one ended.
   */
  watchdog?: { tickMs: number; check: () => Promise<StopReason | null> };
}

function runGit(args: string[], opts: RunOptions): Promise<GitRun> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let stopped: StopReason | null = null;
    let exited = false;
    let settled = false;
    // Set once the promise has resolved or rejected; the watchdog checks it so a
    // tick in flight during a spawn failure cannot re-arm itself afterwards.
    let done = false;
    let exitCode: number | null = null;

    // The wall clock and the idle timer are the two that stop a live process; the
    // grace timer only runs after the process has already exited and is never
    // cleared by a stop.
    let wall: NodeJS.Timeout | null = null;
    let idle: NodeJS.Timeout | null = null;
    let grace: NodeJS.Timeout | null = null;
    let watchdog: NodeJS.Timeout | null = null;
    const clearLive = () => {
      if (wall) clearTimeout(wall);
      if (idle) clearTimeout(idle);
      if (watchdog) clearTimeout(watchdog);
      wall = idle = watchdog = null;
    };

    const settle = () => {
      if (settled) return;
      settled = true;
      done = true;
      clearLive();
      if (grace) clearTimeout(grace);
      resolve({ code: exitCode ?? 1, stdout, stderr, stopped });
    };
    const stop = (why: StopReason) => {
      // Once the process has exited there is nothing to stop; a late timer must
      // not relabel a finished run.
      if (stopped || exited) return;
      stopped = why;
      clearLive();
      killTree(child);
    };

    wall = setTimeout(() => stop("wall-clock"), opts.wallClockMs);
    idle = setTimeout(() => stop("inactivity"), opts.inactivityMs);
    const touch = () => {
      if (stopped || exited) return;
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => stop("inactivity"), opts.inactivityMs);
    };
    if (opts.watchdog) {
      const { tickMs, check } = opts.watchdog;
      const tick = async () => {
        if (stopped || exited || done) return;
        const reason = await check();
        if (stopped || exited || done) return;
        if (reason) stop(reason);
        else watchdog = setTimeout(tick, tickMs);
      };
      watchdog = setTimeout(tick, tickMs);
    }

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
      touch();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-STDERR_KEEP);
      touch();
    });
    child.on("error", (e) => {
      done = true;
      clearLive();
      reject(new GitUnavailableError(e.message));
    });
    // 'exit' is the process ending; 'close' is the pipes ending too. Wait for the
    // pipes briefly so a fast failure's stderr is complete, but never depend on
    // them: an orphaned helper can hold a pipe open indefinitely — if the grace
    // runs out, whatever still holds the pipe is killed and the run settles.
    child.on("exit", (code) => {
      exited = true;
      exitCode = code ?? 1;
      clearLive();
      grace = setTimeout(() => {
        killTree(child);
        settle();
      }, 2_000);
    });
    child.on("close", settle);
  });
}

export interface TreeStats {
  files: string[];
  bytes: number;
  /** Set when a cap was hit and the walk stopped early. */
  over: "files" | "bytes" | null;
}

/**
 * Walks a checked-out tree without blocking the event loop, stopping as soon as
 * either cap is passed. Skips `.git` and never follows symlinks — a symlink in a
 * cloned repo can point anywhere on the host.
 *
 * Early exit is what makes this safe to run repeatedly during a clone: a hostile
 * repository of a million empty files is refused after `maxFiles` entries, not
 * after a full walk. Measured before this change: a synchronous walk of 100,000
 * files blocked the process for 1.3–1.6 s per call.
 */
export async function walkTree(
  root: string,
  caps: { maxFiles: number; maxBytes: number; includeGit?: boolean }
): Promise<TreeStats> {
  const files: string[] = [];
  let bytes = 0;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop()!;
    let dir: fs.Dir;
    try {
      dir = await fs.promises.opendir(current);
    } catch {
      continue;
    }
    for await (const entry of dir) {
      // The artifact walk excludes the repository's own store; the size watchdog
      // includes it, because the pack is most of what a clone writes.
      if (entry.name === ".git" && current === root && !caps.includeGit) continue;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      // Returning from inside `for await` closes the handle through the iterator's
      // own return(); closing it here as well would close it twice.
      files.push(full);
      if (files.length > caps.maxFiles) return { files, bytes, over: "files" };
      try {
        bytes += (await fs.promises.stat(full)).size;
      } catch {
        /* removed mid-walk */
      }
      if (bytes > caps.maxBytes) return { files, bytes, over: "bytes" };
    }
  }
  return { files, bytes, over: null };
}

export interface CloneOptions {
  /** Runtime git config for the clone, e.g. the App token as an extra header. */
  config?: GitConfigPair[];
  /** Empty directory the child treats as its home; must exist. */
  home: string;
  /** Hard limit for the whole clone. */
  wallClockMs?: number;
  /** Limit on silence: progress is forced to stderr so a healthy clone keeps talking. */
  inactivityMs?: number;
  /** The clone is stopped once the checkout passes either cap, or `lowDisk` says so. */
  caps?: { maxFiles: number; maxBytes: number; lowDisk?: () => Promise<boolean> };
}

/**
 * Shallow-clones one repository into `dest` (a directory that does not exist yet
 * or is empty) and returns the commit it checked out.
 *
 * Depth 1, one branch, no tags: a build needs the tip's files, not history. `--`
 * ends option parsing, so the URL can never be read as a flag. `--progress` forces
 * progress output even without a terminal, which is what the inactivity timer
 * listens to.
 */
export async function cloneRepo(
  cloneUrl: string,
  dest: string,
  opts: CloneOptions
): Promise<{ sha: string }> {
  const inactivityMs = opts.inactivityMs ?? 60_000;
  const env = gitEnv(opts.config, {
    home: opts.home,
    // A little longer than the inactivity timer, so a stall is reported by this
    // module's own classification rather than as git's "curl 28".
    lowSpeedTimeSec: Math.max(10, Math.floor(inactivityMs / 1000) + 15),
  });
  const caps = opts.caps;
  let diskCheckFailed = false;
  const clone = await runGit(
    ["clone", "--depth", "1", "--single-branch", "--no-tags", "--progress", "--", cloneUrl, dest],
    {
      env,
      wallClockMs: opts.wallClockMs ?? 5 * 60_000,
      inactivityMs,
      watchdog: caps
        ? {
            // Two seconds: git writes at line speed, so the overshoot between
            // observations is bounded by that window, not by ten of them.
            tickMs: 2_000,
            check: async () => {
              if (caps.lowDisk) {
                try {
                  if (await caps.lowDisk()) return "disk";
                } catch (e) {
                  // A failing disk check must not silently disable the guard.
                  if (!diskCheckFailed) {
                    diskCheckFailed = true;
                    console.error("clone watchdog: free-disk check failed:", e instanceof Error ? e.message : e);
                  }
                }
              }
              // Git writes the pack (under .git) and then the checkout; twice the
              // byte cap leaves room for both before the watchdog calls it.
              try {
                const t = await walkTree(dest, {
                  maxFiles: caps.maxFiles,
                  maxBytes: caps.maxBytes * 2,
                  includeGit: true,
                });
                return t.over === "files" ? "files" : t.over === "bytes" ? "size" : null;
              } catch {
                // The tree is changing under the walk; the next tick sees it settled.
                return null;
              }
            },
          }
        : undefined,
    }
  );
  if (clone.stopped) throw new CloneTimeoutError(clone.stopped);
  if (clone.code !== 0) {
    if (UNREADABLE.test(clone.stderr)) throw new RepoUnreadableError(clone.stderr);
    if (STALLED.test(clone.stderr)) throw new CloneTimeoutError("inactivity");
    throw new CloneError(clone.stderr);
  }

  const head = await runGit(["rev-parse", "HEAD"], {
    env: gitEnv([], { home: opts.home }),
    cwd: dest,
    wallClockMs: 30_000,
    inactivityMs: 30_000,
  });
  if (head.code !== 0) {
    // A repository with no commits clones successfully (git warns) and has no HEAD.
    if (/ambiguous argument 'HEAD'|unknown revision|Needed a single revision/.test(head.stderr)) {
      throw new EmptyRepoError();
    }
    throw new CloneError(head.stderr);
  }
  return { sha: head.stdout.trim() };
}

const OWNER_OR_NAME = /^[A-Za-z0-9_.-]+$/;

/**
 * "owner/name" from the repo picker. The two parts become a URL and an object key
 * prefix, so they are checked here and nowhere else. A leading dot is legal on
 * GitHub (every `owner/.github` profile repo has one); only "." and ".." are not.
 */
export function parseRepoFullName(input: unknown): { owner: string; name: string } | null {
  if (typeof input !== "string") return null;
  const parts = input.split("/");
  if (parts.length !== 2) return null;
  let [owner, name] = parts;
  if (name.endsWith(".git")) name = name.slice(0, -4);
  for (const part of [owner, name]) {
    if (!OWNER_OR_NAME.test(part) || part === "." || part === ".." || part.startsWith("-")) {
      return null;
    }
  }
  return { owner, name };
}

/**
 * A pasted URL, reduced to the one shape this platform clones anonymously:
 * https://github.com/owner/name. Anything else is rejected before git sees it —
 * other hosts, other protocols, a username or token in the URL (which git would
 * write into .git/config and echo in errors), or a value that starts with "-".
 */
export function canonicalGithubUrl(input: unknown): string | null {
  if (typeof input !== "string" || input.startsWith("-")) return null;
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return null;
  if (url.username || url.password) return null;
  const repo = parseRepoFullName(url.pathname.replace(/^\/+/, "").replace(/\/+$/, ""));
  if (!repo) return null;
  return `https://github.com/${repo.owner}/${repo.name}`;
}

/** Object key for one cloned file: output/{id}/<path inside the repo>, with "/" separators. */
export function objectKey(id: string, root: string, file: string): string {
  return `output/${id}/${path.relative(root, file).split(path.sep).join("/")}`;
}

/**
 * Runs `fn` over `items` with at most `limit` in flight. The first failure stops
 * the pool: no worker takes another item, and the signal handed to `fn` is aborted
 * so callers can cancel the requests already in flight. An optional `parent`
 * signal (a deadline) aborts the pool the same way — one listener for the whole
 * pool, not one composite signal per item. Rejects with the first failure.
 */
export async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, signal: AbortSignal) => Promise<R>,
  parent?: AbortSignal
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const controller = new AbortController();
  let failure: { error: unknown } | null = null;
  const onParentAbort = () => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener("abort", onParentAbort, { once: true });
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !failure && !controller.signal.aborted) {
      const i = next++;
      try {
        results[i] = await fn(items[i], controller.signal);
      } catch (e) {
        if (!failure) {
          failure = { error: e };
          controller.abort();
        }
        return;
      }
    }
  });
  await Promise.all(workers);
  parent?.removeEventListener("abort", onParentAbort);
  if (failure) throw (failure as { error: unknown }).error;
  if (controller.signal.aborted) throw parent?.reason ?? new Error("upload pool aborted");
  return results;
}
