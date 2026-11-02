/**
 * Git awareness for the capture hook — client-side, time-bounded, cached.
 *
 * Every git call has a hard timeout and fails soft (null), so a slow or huge repo
 * can only cost a few hundred milliseconds, and never in the agent's way: the
 * snapshot is taken in the detached sender child, not in the hook itself. Results
 * are cached under ~/.reins/state so we don't run git on every tool call.
 *
 * Dependency-free: only Node built-ins.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { readJson, writeJson, stateFile } from "./state.mjs";

const GIT_TIMEOUT_MS = 500;
const ROOT_TTL_MS = 60 * 60 * 1000; // a cwd's repo root rarely changes
const SNAPSHOT_TTL_MS = 15 * 1000; // branch/dirty state: refreshed at most every 15s
const MAX_DIRTY_FILES = 50;

function git(args, cwd, timeout = GIT_TIMEOUT_MS) {
  try {
    return execFileSync("git", args, {
      cwd,
      timeout,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
  } catch {
    return null;
  }
}

/** The main repo root from `git rev-parse --git-common-dir` output (absolute): the
 *  common dir minus its `/.git`. Submodules and bare repos have no such root: `toplevel` stands in. */
export function mainRootOf(common, toplevel) {
  return /[\\/]\.git$/.test(common || "") ? common.replace(/[\\/]\.git$/, "") : toplevel;
}

/**
 * The worktree (git toplevel) and main repo root for a directory (cached), or
 * null outside a repo. In the main checkout both are the same folder; in a linked
 * worktree `repoRoot` is the main repo (the git common dir minus its `/.git`), so
 * every worktree of a repo can be mapped to the same project.
 */
export function repoRoots(cwd) {
  if (!cwd) return null;
  const file = stateFile("roots.json");
  const cache = readJson(file) || {};
  const hit = cache[cwd];
  if (hit && Date.now() - hit.at < ROOT_TTL_MS && (hit.root === null || hit.repoRoot)) {
    return hit.root ? { worktree: hit.root, repoRoot: hit.repoRoot } : null;
  }
  // One call for both; an old git without --path-format falls back to the toplevel alone.
  const out = git(["rev-parse", "--show-toplevel", "--path-format=absolute", "--git-common-dir"], cwd);
  let root = null;
  let repoRoot = null;
  if (out) {
    const [top, common] = out.trim().split("\n");
    root = top || null;
    repoRoot = mainRootOf(common, root);
  } else {
    const top = git(["rev-parse", "--show-toplevel"], cwd);
    root = top ? top.trim() : null;
    repoRoot = root;
  }
  // Keep the cache small: drop entries past their TTL.
  for (const k of Object.keys(cache)) if (Date.now() - cache[k].at >= ROOT_TTL_MS) delete cache[k];
  cache[cwd] = { root, repoRoot, at: Date.now() };
  writeJson(file, cache);
  return root ? { worktree: root, repoRoot } : null;
}

/** The git repo root (worktree toplevel) for a directory (cached), or null outside a repo. */
export function gitRoot(cwd) {
  return repoRoots(cwd)?.worktree ?? null;
}

/**
 * Where a session runs, for every event we send: { branch, worktree, repo_root }
 * (keys left out when unknown). Roots are cached; the branch is one quick git call,
 * so a worktree that switches branches is never reported stale.
 */
export function gitIdentity(cwd) {
  const r = repoRoots(cwd);
  if (!r) return {};
  const head = git(["rev-parse", "--abbrev-ref", "HEAD"], r.worktree);
  const branch = head ? head.trim() : "";
  return { ...(branch && branch !== "HEAD" ? { branch } : {}), worktree: r.worktree, repo_root: r.repoRoot };
}

/**
 * A file path relative to the repo root, forward-slashed, so teammates on
 * different machines name the same file the same way. Null when the file is
 * outside the repo (or there is no repo) — those touches aren't shared.
 */
export function repoPath(file, cwd) {
  if (!file) return null;
  const root = gitRoot(cwd);
  if (!root) return null;
  const abs = isAbsolute(file) ? file : resolve(cwd || root, file);
  // Compare real paths: symlinked dirs (e.g. macOS /var → /private/var) would
  // otherwise put a file inside the repo "outside" it. A file about to be created
  // may not exist yet, so resolve its nearest existing ancestor instead.
  const real = (p) => { try { return realpathSync(p); } catch { return null; } };
  let target = abs;
  for (let dir = abs, rest = ""; ; ) {
    const r = real(dir);
    if (r) { target = rest ? resolve(r, rest) : r; break; }
    const up = dirname(dir);
    if (up === dir) break;
    rest = rest ? `${basename(dir)}/${rest}` : basename(dir);
    dir = up;
  }
  const rel = relative(real(root) || root, target).replace(/\\/g, "/");
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel;
}

/** Parse `git status --porcelain=v1 -z` into repo-relative paths. */
export function parsePorcelain(out) {
  const files = [];
  const parts = (out || "").split("\0");
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    const xy = e.slice(0, 2);
    files.push(e.slice(3));
    if (xy[0] === "R" || xy[0] === "C") i++; // a rename/copy carries its old path next
  }
  return files;
}

function defaultBranch(root) {
  const head = git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], root);
  if (head && head.trim()) return head.trim().replace(/^origin\//, "");
  for (const b of ["main", "master"]) {
    if (git(["show-ref", "--verify", "--quiet", `refs/heads/${b}`], root) !== null) return b;
  }
  return null;
}

/**
 * Branch, short HEAD, default branch, and dirty files for the repo containing
 * `cwd`; null outside a repo. Cached for SNAPSHOT_TTL_MS per repo. When a fresh
 * snapshot shows the member moved from a work branch onto the default branch and
 * the default branch now contains their previous HEAD (`merge-base
 * --is-ancestor`), it carries `merged: {branch, head}` — once, never from cache.
 */
export function gitSnapshot(cwd) {
  const root = gitRoot(cwd);
  if (!root) return null;
  const file = stateFile(`git-${createHash("sha1").update(root).digest("hex").slice(0, 12)}.json`);
  const cache = readJson(file);
  if (cache?.snap && Date.now() - cache.at < SNAPSHOT_TTL_MS) return cache.snap;

  // One call: the full SHA first, then the branch (--abbrev-ref applies to what follows it).
  const rp = git(["rev-parse", "HEAD", "--abbrev-ref", "HEAD"], root);
  const [fullHead, branch] = rp ? rp.trim().split("\n") : [null, null];
  const status = git(["status", "--porcelain=v1", "-z", "--untracked-files=normal"], root, 1500);
  const dirtyAll = status === null ? [] : parsePorcelain(status);
  const snap = {
    branch: branch || undefined,
    head: fullHead ? fullHead.slice(0, 12) : undefined,
    defaultBranch: cache?.snap?.defaultBranch || defaultBranch(root) || undefined,
    dirty: dirtyAll.length,
    dirtyFiles: dirtyAll.slice(0, MAX_DIRTY_FILES),
  };

  let merged;
  const prev = cache?.snap;
  if (
    prev?.branch && cache?.fullHead && snap.defaultBranch &&
    prev.branch !== snap.defaultBranch && prev.branch !== "HEAD" &&
    snap.branch === snap.defaultBranch &&
    git(["merge-base", "--is-ancestor", cache.fullHead, "HEAD"], root) !== null
  ) {
    merged = { branch: prev.branch, head: prev.head };
  }
  writeJson(file, { at: Date.now(), snap, fullHead: fullHead || null });
  return merged ? { ...snap, merged } : snap;
}
