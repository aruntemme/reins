#!/usr/bin/env node
/**
 * Reins adapter for OpenAI Codex CLI.
 *
 * CONCRETE integration. Codex CLI supports a `notify` program: set
 *   notify = ["node", "/abs/path/to/codex.mjs"]
 * in ~/.codex/config.toml. Codex then spawns the program with a single JSON
 * argument describing the event. The shape we target (current Codex CLI):
 *   {
 *     "type": "agent-turn-complete",
 *     "turn-id": "...",
 *     "input-messages": ["the user's prompt", ...],
 *     "last-assistant-message": "what Codex answered"
 *   }
 * We also read JSON on stdin as a fallback for wrappers that pipe instead of
 * passing argv, so the same adapter works either way.
 *
 * Env: REINS_URL, REINS_KEY, REINS_PROJECT, REINS_MEMBER.
 */
import { resolveMember, sendEvent } from "../lib/capture.mjs";
import { readStdinJson, resolveProject } from "./_shared.mjs";

export const SOURCE = "codex";

/**
 * Pure mapping from a Codex notify payload to a Reins event.
 * Exported for unit tests.
 *
 * agent-turn-complete carries both the prompt and the answer; we surface the
 * assistant's reply as the team-visible signal (a "summary" of the turn),
 * falling back to the prompt as an "intent" when no answer is present yet.
 *
 * @param {object} payload
 * @returns {{kind: "intent"|"progress"|"summary", text: string}}
 */
export function mapCodex(payload = {}) {
  const type = payload.type || payload["type"] || "";
  const answer = typeof payload["last-assistant-message"] === "string"
    ? payload["last-assistant-message"].trim()
    : "";
  const inputs = Array.isArray(payload["input-messages"]) ? payload["input-messages"] : [];
  const prompt = inputs.filter((m) => typeof m === "string").join("\n").trim();

  if (type === "agent-turn-complete") {
    if (answer) return { kind: "summary", text: answer };
    if (prompt) return { kind: "intent", text: prompt };
  }
  // Unknown/other notification types: best-effort, prefer the answer then prompt.
  if (answer) return { kind: "summary", text: answer };
  if (prompt) return { kind: "intent", text: prompt };
  return { kind: "progress", text: "" };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  // Codex passes the event JSON as the first CLI argument; fall back to stdin.
  let payload = {};
  const arg = process.argv[2];
  if (arg && arg.trim().startsWith("{")) {
    try { payload = JSON.parse(arg); } catch { payload = {}; }
  }
  if (!payload || Object.keys(payload).length === 0) payload = readStdinJson();

  const { kind, text } = mapCodex(payload);
  if (!text) process.exit(0);

  sendEvent({
    url: process.env.REINS_URL,
    key: process.env.REINS_KEY,
    project: resolveProject(payload),
    member: process.env.REINS_MEMBER || resolveMember(),
    kind,
    text,
    session: payload["turn-id"] || payload.session_id,
    source: SOURCE,
    meta: { event: payload.type || "" },
  }).finally(() => process.exit(0));
}
