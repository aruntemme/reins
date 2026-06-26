#!/usr/bin/env node
/**
 * Reins capture hook for Claude Code.
 *
 * Wire it up in .claude/settings.json (see hooks/README.md). It reads the hook
 * payload on stdin and ships an intent/progress/summary signal to the Reins
 * server. It NEVER blocks your agent: short timeout, always exits 0.
 *
 * This is a thin Claude-Code adapter over the shared capture core in
 * ./lib/capture.mjs — other agent harnesses ship their own adapter over the
 * same core.
 *
 * Env:
 *   REINS_URL      default http://localhost:4319
 *   REINS_PROJECT  default = basename of cwd
 *   REINS_MEMBER   default = git user.email | $USER
 *   REINS_KEY      shared ingest secret (optional)
 *   REINS_SOURCE   capture source label (default "claude-code")
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveMember, lastAssistantText, sendEvent } from "./lib/capture.mjs";

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

// When imported (tests/adapters), don't run the hook body.
// Use pathToFileURL so the comparison holds on Windows too, where the real URL
// is file:///C:/… — a hand-built `file://${argv[1]}` never matches and the hook
// body would silently never run.
const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const hook = readStdin();
  const project = process.env.REINS_PROJECT || basename(hook.cwd || process.cwd()) || "default";
  const { kind, text } = mapClaudeHook(hook);

  if (!text) process.exit(0);

  sendEvent({
    url: process.env.REINS_URL,
    key: process.env.REINS_KEY,
    project,
    member: resolveMember(),
    kind,
    text,
    session: hook.session_id,
    source: process.env.REINS_SOURCE || "claude-code",
    meta: { cwd: hook.cwd, event: hook.hook_event_name || "" },
  }).finally(() => process.exit(0));
}
