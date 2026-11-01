#!/usr/bin/env node
/**
 * Reins capture hook for Claude Code.
 *
 * Wire it up with `npx reins-hook install`. It reads the hook payload on stdin
 * and, depending on the event:
 *   SessionStart       → injects a compact team pack (≤ ~300 tokens) as context
 *   UserPromptSubmit   → ships the prompt as an intent event, and injects a short
 *                        delta only when something relevant changed
 *   PreToolUse (edits) → warns the model (never blocks) when a present teammate is
 *                        on the same file or it's assigned to someone else
 *   PostToolUse (edits)→ records the touched path
 *   Stop / SubagentStop→ ships the last assistant turn as a summary
 *
 * It NEVER blocks or noticeably slows your agent: writes go out from a detached
 * child process, and every read the agent waits on has a hard timeout (800ms for
 * context, 300ms for the pre-edit check). If the server is down or slow it prints
 * nothing and exits 0.
 *
 * Connection (lib/config.mjs resolveRuntime): explicit env wins; else
 * ~/.reins/config.json — the repo map by git root of cwd gives url + project and
 * the server entry gives the token + member; else the fallbacks below.
 *   REINS_URL      default http://localhost:4319
 *   REINS_PROJECT  default = basename of cwd
 *   REINS_MEMBER   default = git user.email | $USER
 *   REINS_KEY      ingest token (sent as x-reins-key)
 *   REINS_SOURCE   capture source label (default "claude-code")
 *   REINS_CONTEXT  "off" disables context injection and the pre-edit check
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  lastAssistantText, sendEvent, sendEventDetached, sendTouchDetached, postJson,
} from "./lib/capture.mjs";
import { repoPath } from "./lib/git.mjs";
import { resolveRuntime } from "./lib/config.mjs";
import { readJson, writeJson, sessionFile, pruneSessions } from "./lib/state.mjs";

// Claude Code's file-editing tools (MultiEdit kept for older Claude Code versions).
export const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const CONTEXT_TIMEOUT_MS = 800;
const CHECK_TIMEOUT_MS = 300;
const CHECK_CACHE_MS = 30_000; // re-editing the same file doesn't re-ask the server
const MAX_SEEN = 300;

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

/** Map a Claude Code hook payload to a common Reins event ({kind, text}). */
export function mapClaudeHook(hook) {
  const evt = hook.hook_event_name || "";
  if (evt === "UserPromptSubmit") return { kind: "intent", text: (hook.prompt || "").trim() };
  if (evt === "Stop" || evt === "SubagentStop")
    return { kind: "summary", text: lastAssistantText(hook.transcript_path || "") };
  if (hook.prompt) return { kind: "progress", text: String(hook.prompt).trim() };
  return { kind: "progress", text: `${evt} event` };
}

/** The path an edit tool is about to change / just changed. */
export function editedFile(hook) {
  const ti = hook.tool_input || {};
  return ti.file_path || ti.notebook_path || "";
}

/** Print hook JSON output, then exit once stdout has flushed. */
function emit(out) {
  process.stdout.write(JSON.stringify(out), () => process.exit(0));
}

function contextOutput(event, text) {
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}

// When imported (tests/adapters), don't run the hook body.
// Use pathToFileURL so the comparison holds on Windows too, where the real URL
// is file:///C:/… — a hand-built `file://${argv[1]}` never matches and the hook
// body would silently never run.
const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  // Backstop: whatever happens below, never outlive the slowest budget by much.
  setTimeout(() => process.exit(0), 2000).unref();
  main().catch(() => process.exit(0));
}

async function main() {
  const hook = readStdin();
  const evt = hook.hook_event_name || "";
  const rt = resolveRuntime({ cwd: hook.cwd || process.cwd() });
  const { project, member } = rt;
  const conn = { url: rt.url, key: rt.key };
  const source = rt.source;
  const inject = (process.env.REINS_CONTEXT || "").toLowerCase() !== "off";
  const state = readJson(sessionFile(hook.session_id)) || null;
  const save = (s) => writeJson(sessionFile(hook.session_id), s);

  /** Fetch the member's pack (start) or what changed since this session's seen keys (delta). */
  async function pack(mode, query) {
    const r = await postJson(conn, "/api/hook/pack", {
      project, member, mode, query, seen: mode === "delta" ? state?.seen ?? [] : undefined,
    }, CONTEXT_TIMEOUT_MS);
    if (!r.ok || !r.json) return null;
    const seen = [...(mode === "delta" ? state?.seen ?? [] : []), ...(r.json.shown || [])].slice(-MAX_SEEN);
    save({ ...(state || {}), version: r.json.version || "", seen, at: Date.now() });
    return r.json.text || "";
  }

  if (evt === "SessionStart") {
    pruneSessions();
    if (!inject) return process.exit(0);
    const text = await pack("start");
    return text ? emit(contextOutput("SessionStart", text)) : process.exit(0);
  }

  if (evt === "UserPromptSubmit") {
    const prompt = (hook.prompt || "").trim();
    if (prompt) {
      const event = {
        ...conn, project, member, kind: "intent", text: prompt, session: hook.session_id,
        source, cwd: hook.cwd,
        meta: { cwd: hook.cwd, event: evt },
      };
      // Fire-and-forget from a detached child, before we wait on anything.
      if (!sendEventDetached(event)) void sendEvent({ ...event, timeoutMs: CONTEXT_TIMEOUT_MS });
    }
    if (!inject) return process.exit(0);
    // A session we haven't primed (e.g. installed before SessionStart was hooked)
    // gets the full pack once; after that only deltas.
    const text = await pack(state ? "delta" : "start", prompt.slice(0, 2000));
    return text ? emit(contextOutput("UserPromptSubmit", text)) : process.exit(0);
  }

  if (evt === "PreToolUse") {
    if (!inject || !EDIT_TOOLS.has(hook.tool_name)) return process.exit(0);
    const path = repoPath(editedFile(hook), hook.cwd);
    if (!path) return process.exit(0);
    const cached = state?.checks?.[path];
    let text = "";
    if (cached && Date.now() - cached.at < CHECK_CACHE_MS) {
      text = cached.text;
    } else {
      const r = await postJson(conn, "/api/hook/check", { project, member, path }, CHECK_TIMEOUT_MS);
      if (!r.ok || !r.json) return process.exit(0); // down/slow: fail open, cache nothing
      text = r.json.text || "";
      const checks = Object.fromEntries(
        Object.entries(state?.checks || {}).filter(([, v]) => Date.now() - v.at < CHECK_CACHE_MS)
      );
      checks[path] = { at: Date.now(), text };
      save({ ...(state || {}), checks });
    }
    if (!text) return process.exit(0);
    // No permissionDecision: the normal permission flow is untouched and the edit
    // proceeds; the warning reaches the model as context, and the user as a notice.
    return emit({
      hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text },
      systemMessage: text.split(". This is advisory")[0],
    });
  }

  if (evt === "PostToolUse") {
    if (!EDIT_TOOLS.has(hook.tool_name)) return process.exit(0);
    const file = editedFile(hook);
    if (file) sendTouchDetached({ ...conn, project, member, file, cwd: hook.cwd, tool: hook.tool_name });
    return process.exit(0);
  }

  const { kind, text } = mapClaudeHook(hook);
  if (!text) return process.exit(0);
  const event = {
    ...conn, project, member, kind, text, session: hook.session_id,
    source, cwd: hook.cwd,
    meta: { cwd: hook.cwd, event: evt },
  };
  // Fire-and-forget from a detached child; only if spawning fails do we send
  // inline (still bounded by sendEvent's short timeout).
  if (sendEventDetached(event)) process.exit(0);
  else sendEvent(event).finally(() => process.exit(0));
}
