/**
 * ~/.reins/config.json — where the setup wizard keeps who you are on each Reins
 * server and which project each repo reports to, so agent settings files only
 * ever carry REINS_SOURCE and never a token.
 *
 *   {
 *     "version": 1,
 *     "servers": { "<url>": { "token": "rk_…", "member": "asha@acme.dev", "workspace": { "id", "name" } } },
 *     "repos":   { "/abs/git/root": { "url": "<url>", "project": "checkout-v2" } }
 *   }
 *
 * Runtime resolution (the hook and every adapter): explicit env wins, field by
 * field; else repos[<git root of cwd>] (or the nearest mapped ancestor of cwd)
 * gives url + project and servers[url] gives token + member; else the old
 * fallbacks (localhost, folder name, git email → $USER).
 *
 * Dependency-free; every read fails soft (a missing or corrupt file is "no config").
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import os from "node:os";
import { gitRoot } from "./git.mjs";

export const DEFAULT_RUNTIME_URL = "http://localhost:4319";
export const HOSTED_URL = "https://reinshq.vercel.app";

export const reinsDir = () => join(os.homedir(), ".reins");
export const configPath = () => join(reinsDir(), "config.json");

/** "https://x.dev/" → "https://x.dev". The servers map is keyed by this form. */
export function normalizeUrl(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

function empty() {
  return { version: 1, servers: {}, repos: {} };
}

/** The parsed config, always with `servers` and `repos` objects. Never throws. */
export function loadConfig(path = configPath()) {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!raw || typeof raw !== "object") return empty();
    return {
      ...raw,
      version: 1,
      servers: raw.servers && typeof raw.servers === "object" ? raw.servers : {},
      repos: raw.repos && typeof raw.repos === "object" ? raw.repos : {},
    };
  } catch {
    return empty();
  }
}

/** Write the config atomically with mode 0600 (it holds ingest tokens). */
export function saveConfig(cfg, path = configPath()) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...cfg, version: 1 }, null, 2) + "\n", { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* best effort (Windows) */ }
  renameSync(tmp, path);
  try { chmodSync(path, 0o600); } catch { /* best effort */ }
  return path;
}

/**
 * Merge a server credential and/or a repo mapping into the config and save it.
 * `server` = { url, token?, member?, workspace? }; `repo` = { root, url, project }.
 * Fields left undefined keep their stored value.
 */
export function rememberSetup({ server, repo } = {}, path = configPath()) {
  const cfg = loadConfig(path);
  if (server?.url) {
    const url = normalizeUrl(server.url);
    const prev = cfg.servers[url] || {};
    const next = { ...prev };
    for (const k of ["token", "member", "workspace"]) if (server[k] !== undefined) next[k] = server[k];
    cfg.servers[url] = next;
  }
  if (repo?.root) {
    cfg.repos[repo.root] = { url: normalizeUrl(repo.url), project: repo.project };
  }
  saveConfig(cfg, path);
  return cfg;
}

/** Remove the repo mappings (and, with `credentials`, every server entry). */
export function forgetSetup({ root, credentials = false } = {}, path = configPath()) {
  if (!existsSync(path)) return { removed: false };
  const cfg = loadConfig(path);
  let removed = false;
  if (root && cfg.repos[root]) { delete cfg.repos[root]; removed = true; }
  if (credentials) {
    if (Object.keys(cfg.servers).length || Object.keys(cfg.repos).length) removed = true;
    cfg.servers = {};
    cfg.repos = {};
  }
  if (removed) saveConfig(cfg, path);
  return { removed };
}

/**
 * The repo entry for a working directory: the git root's entry, else the nearest
 * mapped ancestor of cwd (a folder set up outside git is keyed by its own path).
 * Returns { root, url, project } or null.
 */
export function repoEntry(cfg, cwd) {
  const repos = cfg?.repos || {};
  if (!cwd) return null;
  const root = gitRoot(cwd);
  if (root && repos[root]) return { root, ...repos[root] };
  for (let dir = resolve(cwd); ; ) {
    if (repos[dir]) return { root: dir, ...repos[dir] };
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** git user.email for a directory, or null. */
export function gitEmail(cwd) {
  try {
    const out = execFileSync("git", ["config", "user.email"], {
      cwd: cwd || process.cwd(),
      encoding: "utf8",
      timeout: 500,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the connection the hook/adapters use, field by field:
 *   url     REINS_URL      → repos[root].url        → localhost
 *   project REINS_PROJECT  → repos[root].project    → basename(cwd)
 *   key     REINS_KEY      → servers[url].token     → (none)
 *   member  REINS_MEMBER   → servers[url].member    → git email → $USER
 *   source  REINS_SOURCE   → `defaultSource`
 */
export function resolveRuntime({ cwd = process.cwd(), env = process.env, defaultSource = "claude-code", config } = {}) {
  const cfg = config || loadConfig();
  // The repo lookup can cost a git call; skip it when env already pins both fields.
  const repo = env.REINS_URL && env.REINS_PROJECT ? null : repoEntry(cfg, cwd);
  const url = normalizeUrl(env.REINS_URL || repo?.url || DEFAULT_RUNTIME_URL);
  const server = cfg.servers[url] || {};
  let member = env.REINS_MEMBER || server.member || null;
  if (!member) member = gitEmail(cwd) || os.userInfo().username || "unknown";
  return {
    url,
    project: env.REINS_PROJECT || repo?.project || basename(cwd || "") || "default",
    key: env.REINS_KEY || server.token || undefined,
    member,
    source: env.REINS_SOURCE || defaultSource,
    repo: repo || null,
  };
}
