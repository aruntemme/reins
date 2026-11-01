#!/usr/bin/env node
/**
 * Reins adapter for Aider.
 *
 * MOSTLY-CONCRETE integration. Aider does not emit a structured JSON hook the
 * way Claude Code does, but it has two real seams:
 *   1. `notifications: true` + `notifications-command: <cmd>` in ~/.aider.conf.yml
 *      (`npx reins-hook` writes both) runs the command through the shell when
 *      the LLM finishes a turn (no payload). We then read the latest assistant
 *      turn out of aider's chat history file (`.aider.chat.history.md` in cwd or
 *      the git root; override with --history / AIDER_CHAT_HISTORY) and ship it
 *      as a summary.
 *   2. A wrapper can pipe a JSON object ({prompt} or {assistant}/{response}) and
 *      we map that directly, which is the path the unit test exercises.
 *
 * Connection: env, else ~/.reins/config.json by the git root of cwd (see _shared).
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { sendEvent, sendEventDetached } from "../lib/capture.mjs";
import { gitRoot } from "../lib/git.mjs";
import { readStdinJson, pick, parseFlags, connection } from "./_shared.mjs";

export const SOURCE = "aider";

/**
 * Pure mapping from an aider-style payload to a Reins event.
 * Exported for unit tests.
 *
 * A prompt-only payload is the user's intent; an assistant/response payload is
 * the turn summary. `text` already resolved by a caller (e.g. from history) can
 * be passed as payload.text.
 *
 * @param {object} payload
 * @returns {{kind: "intent"|"progress"|"summary", text: string}}
 */
export function mapAider(payload = {}) {
  const assistant = pick(payload, ["assistant", "response", "output", "reply"]);
  if (assistant) return { kind: "summary", text: assistant };
  const prompt = pick(payload, ["prompt", "user", "input", "message"]);
  if (prompt) return { kind: "intent", text: prompt };
  const text = pick(payload, ["text", "content"]);
  if (text) return { kind: "summary", text };
  return { kind: "progress", text: "" };
}

/**
 * Extract the last assistant turn from an aider chat history markdown file.
 * Aider writes user turns as lines prefixed with "#### " and assistant replies
 * as the prose blocks between them. We grab the text after the final "#### ..."
 * marker (the most recent assistant reply). Exported for unit tests.
 *
 * @param {string} md  raw chat-history markdown
 * @returns {string}
 */
export function lastAiderAssistant(md) {
  if (!md || typeof md !== "string") return "";
  const lines = md.split("\n");
  // Find the last user marker; assistant reply is everything after it that is
  // not itself a user marker.
  let lastMarker = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith("#### ")) { lastMarker = i; break; }
  }
  if (lastMarker === -1) return "";
  const after = lines.slice(lastMarker + 1).filter((l) => !l.startsWith("#### "));
  return after.join("\n").replace(/^[\s>]+|[\s>]+$/g, "").trim();
}

const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const flags = parseFlags(process.argv.slice(2));
  let payload = readStdinJson();

  // notifications-command path: no stdin payload, read the history file instead.
  // Aider keeps it at the git root by default, so look there as well as in cwd.
  if (!payload || Object.keys(payload).length === 0) {
    const explicit = (typeof flags.history === "string" && flags.history) || process.env.AIDER_CHAT_HISTORY;
    const root = gitRoot(process.cwd());
    const candidates = explicit
      ? [explicit]
      : [".aider.chat.history.md", ...(root ? [join(root, ".aider.chat.history.md")] : [])];
    const histPath = candidates.find((p) => existsSync(p));
    if (histPath) {
      try {
        const text = lastAiderAssistant(readFileSync(histPath, "utf8"));
        payload = text ? { assistant: text } : {};
      } catch { payload = {}; }
    }
  }

  const { kind, text } = mapAider(payload);
  if (!text) process.exit(0);

  const conn = connection(payload, SOURCE);
  const event = {
    url: conn.url,
    // Git state (branch, dirty files) rides along from the repo the agent runs in.
    cwd: conn.cwd,
    key: conn.key,
    project: conn.project,
    member: conn.member,
    kind,
    text,
    source: SOURCE,
    meta: { event: "aider" },
  };
  // Aider waits for its notifications-command to exit, so hand the POST to a
  // detached child and return at once (inline only if spawning fails).
  if (sendEventDetached(event)) process.exit(0);
  else sendEvent(event).finally(() => process.exit(0));
}
