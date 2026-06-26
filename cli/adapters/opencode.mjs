#!/usr/bin/env node
/**
 * Reins adapter for opencode (sst/opencode).
 *
 * CONCRETE integration via opencode's plugin/event bus. An opencode plugin can
 * subscribe to events and shell out to this adapter, piping the event JSON. The
 * event envelope opencode emits is:
 *   { "type": "message.updated"|"session.idle"|..., "properties": { ... } }
 * For a user turn the prompt rides in properties (text/message); for an
 * idle/finished turn the assistant's text is the team-visible signal.
 *
 * It also accepts a flat {role,text} message object so a minimal wrapper that
 * forwards just the last message still works.
 *
 * Env: REINS_URL, REINS_KEY, REINS_PROJECT, REINS_MEMBER.
 */
import { pathToFileURL } from "node:url";
import { resolveMember, sendEvent } from "../lib/capture.mjs";
import { readStdinJson, pick, resolveProject } from "./_shared.mjs";

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
  sendEvent({
    url: process.env.REINS_URL,
    key: process.env.REINS_KEY,
    project: resolveProject(payload),
    member: process.env.REINS_MEMBER || resolveMember(),
    kind,
    text,
    session: props.sessionID || props.session_id || payload.sessionID,
    source: SOURCE,
    meta: { event: payload.type || "" },
  }).finally(() => process.exit(0));
}
