#!/usr/bin/env node
/**
 * Reins adapter for opencode.
 *
 * CONCRETE integration via opencode's plugin event bus. `npx reins-hook` writes
 * a small plugin to ~/.config/opencode/plugins/reins.js (see
 * lib/agents.mjs#opencodePluginSource) that subscribes to `message.updated`,
 * `message.part.updated` and `session.idle`, and pipes one JSON object per
 * captured turn to this adapter on stdin:
 *   { "type": "message.sent", "properties": { "role": "user", "text": "…", "sessionID": "…" }, "cwd": "/abs/repo" }
 *   { "type": "session.idle", "properties": { "role": "assistant", "text": "…", "sessionID": "…" }, "cwd": "/abs/repo" }
 *
 * It also accepts a flat {role,text} message object so a minimal wrapper that
 * forwards just the last message still works.
 *
 * Connection: env, else ~/.reins/config.json by the payload's cwd (see _shared).
 */
import { pathToFileURL } from "node:url";
import { sendEvent } from "../lib/capture.mjs";
import { readStdinJson, pick, connection } from "./_shared.mjs";

export const SOURCE = "opencode";

/**
 * Pure mapping from an opencode event/message payload to a Reins event.
 * Exported for unit tests.
 *
 * @param {object} payload
 * @returns {{kind: "intent"|"progress"|"summary", text: string}}
 */
export function mapOpencode(payload = {}) {
  const type = payload.type || "";
  const props = (payload.properties && typeof payload.properties === "object") ? payload.properties : payload;

  // The user submitting a prompt -> intent.
  if (type === "message.sent" || props.role === "user") {
    const text = pick(props, ["text", "message.text", "content", "prompt", "message"]);
    if (text) return { kind: "intent", text };
  }

  // A finished turn -> summary of the assistant's reply.
  if (type === "session.idle" || type === "message.updated" || props.role === "assistant") {
    const text = pick(props, ["text", "message.text", "content", "output"]);
    if (text) return { kind: "summary", text };
  }

  // Fallback: any text we can find.
  const text = pick(props, ["text", "message.text", "content", "prompt", "output", "message"]);
  if (!text) return { kind: "progress", text: "" };
  const kind = props.role === "user" ? "intent" : "progress";
  return { kind, text };
}

const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const payload = readStdinJson();
  const { kind, text } = mapOpencode(payload);
  if (!text) process.exit(0);

  const props = payload.properties || payload;
  const conn = connection(payload, SOURCE);
  sendEvent({
    url: conn.url,
    // Git state (branch, dirty files) rides along from the repo the agent runs in.
    cwd: conn.cwd,
    key: conn.key,
    project: conn.project,
    member: conn.member,
    kind,
    text,
    session: props.sessionID || props.session_id || payload.sessionID,
    source: SOURCE,
    meta: { event: payload.type || "" },
  }).finally(() => process.exit(0));
}
