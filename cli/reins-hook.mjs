#!/usr/bin/env node
/**
 * Reins capture hook for Claude Code.
 *
 * Wire it up in .claude/settings.json (see hooks/README.md). It reads the hook
 * payload on stdin and ships an intent/progress signal to the Reins server.
 * It NEVER blocks your agent: short timeout, always exits 0.
 *
 * Env:
 *   REINS_URL      default http://localhost:4319
 *   REINS_PROJECT  default = basename of cwd
 *   REINS_MEMBER   default = git user.email | $USER
 *   REINS_KEY      shared ingest secret (optional)
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import os from "node:os";

const URL = (process.env.REINS_URL || "http://localhost:4319").replace(/\/$/, "");
const KEY = process.env.REINS_KEY || "";

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

function member() {
  if (process.env.REINS_MEMBER) return process.env.REINS_MEMBER;
  try {
    const email = execSync("git config user.email", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    if (email) return email;
  } catch {}
  return os.userInfo().username || "unknown";
}

function lastAssistantText(transcriptPath) {
  try {
    const lines = readFileSync(transcriptPath, "utf8").trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const row = JSON.parse(lines[i]);
      const msg = row.message ?? row;
      if (msg?.role !== "assistant") continue;
      const content = msg.content;
      const txt = Array.isArray(content)
        ? content.filter((b) => b.type === "text").map((b) => b.text).join("\n")
        : typeof content === "string"
          ? content
          : "";
      if (txt.trim()) return txt.trim();
    }
  } catch {}
  return "";
}

const hook = readStdin();
const project =
  process.env.REINS_PROJECT || basename(hook.cwd || process.cwd()) || "default";
const evt = hook.hook_event_name || "";

let kind = "progress";
let text = "";

if (evt === "UserPromptSubmit") {
  kind = "intent";
  text = (hook.prompt || "").trim();
} else if (evt === "Stop" || evt === "SubagentStop") {
  kind = "summary";
  text = lastAssistantText(hook.transcript_path || "");
} else if (hook.prompt) {
  text = String(hook.prompt).trim();
} else {
  text = `${evt} event`;
}

if (!text) process.exit(0);
if (text.length > 6000) text = text.slice(0, 6000);

const body = JSON.stringify({
  project,
  member: member(),
  kind,
  text,
  session: hook.session_id,
  meta: { cwd: hook.cwd, event: evt },
});

const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), 1500);

fetch(`${URL}/api/ingest`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(KEY ? { "x-reins-key": KEY } : {}) },
  body,
  signal: ctrl.signal,
})
  .catch(() => {})
  .finally(() => {
    clearTimeout(timer);
    process.exit(0);
  });
