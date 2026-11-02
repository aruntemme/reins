/**
 * Reins capture core — the shared, harness-agnostic plumbing that ships a
 * captured signal to the Reins server. The Claude Code hook and every other
 * agent adapter (Codex, opencode, pi, Hermes, Koda, ...) are thin wrappers that
 * map their own payload shape into a common event and call `sendEvent` here.
 *
 * Dependency-free: only Node built-ins, so `npx` has nothing to install. It is
 * non-blocking by contract — short timeout, never throws, resolves to a small
 * result object so adapters can `await` it in tests without crashing a session.
 */
import { execSync, spawn } from "node:child_process";
import { openSync, readSync, fstatSync, closeSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import os from "node:os";
import { redactSecrets } from "./redact.mjs";
import { gitSnapshot, gitIdentity, repoPath } from "./git.mjs";

const DEFAULT_URL = "http://localhost:4319";
const MAX_TEXT = 6000;
// Only the end of a transcript matters (we want the LAST assistant turn), and a
// long session's jsonl can be many MB — read just this much of the tail.
const TAIL_BYTES = 1024 * 1024;

/** Mask credentials, then bound the length (in that order, so a secret is never
 *  half-kept by the cut). */
function prepareText(raw) {
  let text = redactSecrets(String(raw ?? "").trim());
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);
  return text;
}

// Prompts that carry no intent: system-injected blocks and one-word nudges. They
// are never sent as events (the session is still touched by the pack request).
const NOISE_PREFIXES = [
  "<task-notification>", "<system-reminder>", "<command-name>", "<command-message>", "<local-command-",
  "Caveat: The messages below",
];
const NOISE_WORDS = new Set([
  "continue", "go on", "go ahead", "ok", "okay", "yes", "y", "no", "n", "next", "check now", "status",
  "proceed", "done", "thanks",
]);

/** True for a prompt that isn't a real instruction (empty, injected, or a filler word). */
export function isNoisePrompt(raw) {
  const t = String(raw ?? "").trim();
  if (!t) return true;
  if (NOISE_PREFIXES.some((p) => t.startsWith(p))) return true;
  const word = t.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").replace(/\s+/g, " ");
  return NOISE_WORDS.has(word);
}

/** Resolve who the event is from: explicit env, then git email, then $USER. */
export function resolveMember(env = process.env) {
  if (env.REINS_MEMBER) return env.REINS_MEMBER;
  try {
    const email = execSync("git config user.email", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    if (email) return email;
  } catch {
    /* not a git repo / git missing */
  }
  return os.userInfo().username || "unknown";
}

/** Pull the last assistant text block out of a Claude Code transcript jsonl.
 *  Reads only the file's tail, and skips (rather than aborts on) a bad line. */
export function lastAssistantText(transcriptPath) {
  let fd;
  try {
    fd = openSync(transcriptPath, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    let lines = buf.toString("utf8").split("\n");
    if (start > 0) lines = lines.slice(1); // the first line is cut mid-way
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; } // partial/garbled line
      const msg = row?.message ?? row;
      if (msg?.role !== "assistant") continue;
      const content = msg.content;
      const txt = Array.isArray(content)
        ? content.filter((b) => b.type === "text").map((b) => b.text).join("\n")
        : typeof content === "string"
          ? content
          : "";
      if (txt.trim()) return txt.trim();
    }
  } catch {
    /* missing/unreadable transcript */
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
  return "";
}

/**
 * Ship one event to the Reins server. Fire-and-forget by contract: a short
 * timeout, swallows all errors, and resolves to {ok, status?, unreachable?,
 * skipped?} so adapters never block or crash the host agent.
 *
 * @param {object} o
 * @param {string} o.project   project id
 * @param {string} o.member    who (defaults via resolveMember)
 * @param {string} o.text      the captured text (required, trimmed/truncated)
 * @param {"intent"|"progress"|"summary"} [o.kind="progress"]
 * @param {string} [o.source="claude-code"]  capturing harness id
 * @param {string} [o.url]     server url
 * @param {string} [o.key]     ingest key (x-reins-key)
 * @param {string} [o.session] session id
 *
 * Besides session and source, the body carries branch, worktree (git toplevel) and
 * repo_root (main repo root) when cwd is in a repo, so the board can tell a
 * person's agents and worktrees apart. A noise `intent` is dropped (see isNoisePrompt).
 * @param {object} [o.meta]    extra metadata (merged with {source})
 * @param {string} [o.cwd]     working directory; when set, git state (branch,
 *                             HEAD, dirty files, a detected merge) rides in meta.git
 * @param {number} [o.timeoutMs=1500]
 */
export async function sendEvent(o) {
  const source = o.source || "claude-code";
  // Mask credentials before anything leaves the machine (the server masks again
  // at ingest as a backstop).
  const text = prepareText(o.text);
  if (!text || ((o.kind || "progress") === "intent" && isNoisePrompt(text))) return { ok: false, skipped: true };

  const git = o.cwd && o.git !== false ? gitSnapshot(o.cwd) : null;
  const where = o.cwd && o.git !== false ? gitIdentity(o.cwd) : {};
  const r = await postJson(o, "/api/ingest", {
    project: o.project,
    member: o.member || resolveMember(),
    kind: o.kind || "progress",
    text,
    session: o.session,
    source,
    ...where,
    meta: { ...(o.meta || {}), source, ...where, ...(git ? { git } : {}) },
  }, o.timeoutMs ?? 1500);
  return r.unreachable ? { ok: false, unreachable: true } : { ok: r.ok, status: r.status };
}

/**
 * POST JSON to the Reins server with a hard timeout. Never throws: resolves to
 * {ok, status, json} or {ok:false, unreachable:true} (down, slow, or refused).
 * Used by every hook path, so a dead server costs at most `timeoutMs`.
 */
export async function postJson(o, path, payload, timeoutMs) {
  const url = (o.url || process.env.REINS_URL || DEFAULT_URL).replace(/\/$/, "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(o.key ? { "x-reins-key": o.key } : {}) },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    let json = null;
    try { json = await res.json(); } catch { /* not json */ }
    return { ok: res.ok, status: res.status, json };
  } catch {
    return { ok: false, unreachable: true };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Record a real file touch (an edit tool just ran). The path is made relative to
 * the git repo root so teammates on different machines match; a file outside the
 * repo isn't shared. Git state rides along in meta.git.
 */
export async function sendTouch(o) {
  const path = repoPath(o.file, o.cwd);
  if (!path) return { ok: false, skipped: true };
  const git = o.git !== false ? gitSnapshot(o.cwd) : null;
  const where = o.git !== false ? gitIdentity(o.cwd) : {};
  return postJson(o, "/api/hook/touch", {
    project: o.project,
    member: o.member || resolveMember(),
    path,
    tool: o.tool,
    session: o.session,
    source: o.source,
    ...where,
    meta: git ? { git } : undefined,
  }, o.timeoutMs ?? 1500);
}

// A shell command that runs a test suite: npm/pnpm/yarn/bun test, jest, vitest, pytest,
// go/cargo/deno/mix/dotnet test, gradle/maven test, node --test, make test, …
const TEST_COMMAND = new RegExp(
  // Only in command position: at the start, after ; & | ( and any VAR=value prefixes.
  "(?:^|[;&|(])\\s*(?:\\w+=\\S*\\s+)*(?:(?:uv|poetry|pipenv)\\s+run\\s+)?(?:" + [
    "(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?test(?::[\\w:-]+)?(?![\\w-])",
    "(?:npx\\s+|pnpm\\s+(?:exec\\s+)?|yarn\\s+|bunx\\s+)?(?:jest|vitest|mocha|ava|pytest|rspec|phpunit|playwright\\s+test)(?![\\w-])",
    "python3?\\s+-m\\s+(?:pytest|unittest)(?![\\w-])",
    "(?:go|cargo|deno|mix|dotnet)\\s+(?:test|nextest)(?![\\w-])",
    "(?:\\.\\/)?(?:gradlew|gradle|mvn|mvnw)(?:\\s+\\S+)*?\\s+test(?![\\w-])",
    "(?:npx\\s+)?(?:node|tsx|bun)(?:\\s+\\S+)*?\\s+--test(?![\\w-])",
    "make\\s+test(?![\\w-])",
  ].join("|") + ")"
);

/** True when a shell command runs tests (so its pass/fail is a step mark worth showing). */
export function isTestCommand(cmd) {
  return typeof cmd === "string" && TEST_COMMAND.test(cmd);
}

/** Record a test run (passed or failed) on the session's timeline. */
export async function sendRun(o) {
  const where = o.git !== false ? gitIdentity(o.cwd) : {};
  return postJson(o, "/api/hook/run", {
    project: o.project,
    member: o.member || resolveMember(),
    command: redactSecrets(String(o.command || "")).slice(0, 200),
    ok: !!o.ok,
    session: o.session,
    source: o.source,
    ...where,
  }, o.timeoutMs ?? 1500);
}

export function sendRunDetached(o) {
  return spawnDetached({ ...o, command: redactSecrets(String(o.command || "")).slice(0, 200), op: "run" });
}

/**
 * Hand the event to a detached, unref'd child process and return at once, so
 * the host agent never waits on the network (a hook runs on every prompt). The
 * child does the POST with a generous timeout and exits. Text is redacted and
 * capped here first, so the payload is small and no secret ever reaches the
 * child's environment. Returns false if the child couldn't be spawned (callers
 * may then fall back to `sendEvent`).
 */
export function sendEventDetached(o) {
  const text = prepareText(o.text);
  if (!text || ((o.kind || "progress") === "intent" && isNoisePrompt(text))) return true; // nothing to send
  return spawnDetached({ ...o, text });
}

/** sendTouch from a detached child (git + the POST never hold up the agent). */
export function sendTouchDetached(o) {
  return spawnDetached({ ...o, op: "touch" });
}

function spawnDetached(payload) {
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, REINS_EVENT: JSON.stringify(payload) },
    });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// Child entry for sendEventDetached: `node capture.mjs` with REINS_EVENT set.
const isMain = (() => {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; }
  catch { return false; }
})();
if (isMain && process.env.REINS_EVENT) {
  let o = null;
  try { o = JSON.parse(process.env.REINS_EVENT); } catch { /* malformed → nothing to do */ }
  if (!o) process.exit(0);
  const send = o.op === "touch" ? sendTouch : o.op === "run" ? sendRun : sendEvent;
  send({ ...o, timeoutMs: o.timeoutMs ?? 10000 }).finally(() => process.exit(0));
}
