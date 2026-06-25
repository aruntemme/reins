#!/usr/bin/env node
/**
 * Generic Reins adapter — the universal "bring your own agent" path.
 *
 * Any agent that can run a shell command on a prompt/stop event can pipe a JSON
 * object to this adapter (or pass text via flags) and have it land on the Reins
 * board. It maps configurable fields to a common event and calls sendEvent.
 *
 *   echo '{"prompt":"add auth"}' | node generic.mjs --source my-agent --kind intent
 *   node generic.mjs --text "shipped login" --kind summary --source my-agent
 *
 * Field mapping is configurable so you do not have to reshape your agent's
 * payload. Defaults cover the common names:
 *   text  <- REINS_TEXT_FIELDS  or  text,prompt,message,content,input,output
 *   kind  <- --kind / REINS_KIND  or  payload.kind  (default "progress")
 *   source<- --source / REINS_SOURCE  (default "agent")
 *
 * Env: REINS_URL, REINS_KEY, REINS_PROJECT, REINS_MEMBER, REINS_SOURCE,
 *      REINS_KIND, REINS_TEXT_FIELDS (comma list of dot-paths).
 */
import { resolveMember, sendEvent } from "../lib/capture.mjs";
import { readStdinJson, pick, resolveProject, parseFlags } from "./_shared.mjs";

const DEFAULT_TEXT_FIELDS = ["text", "prompt", "message", "content", "input", "output"];
const VALID_KINDS = new Set(["intent", "progress", "summary"]);

/**
 * Pure mapping from a generic payload + options to a Reins event.
 * Exported for unit tests.
 *
 * @param {object} payload   the JSON object from the agent (may be {})
 * @param {object} [opts]
 * @param {string} [opts.text]    explicit text (wins over payload fields)
 * @param {string} [opts.kind]    explicit kind
 * @param {string[]} [opts.textFields]  candidate dot-paths for the text
 * @returns {{kind: "intent"|"progress"|"summary", text: string}}
 */
export function mapGeneric(payload = {}, opts = {}) {
  const fields = opts.textFields && opts.textFields.length ? opts.textFields : DEFAULT_TEXT_FIELDS;
  const text = (opts.text && String(opts.text).trim()) || pick(payload, fields);
  const rawKind = opts.kind || (typeof payload.kind === "string" ? payload.kind : "");
  const kind = VALID_KINDS.has(rawKind) ? rawKind : "progress";
  return { kind, text };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const flags = parseFlags(process.argv.slice(2));
  const payload = readStdinJson();
  const textFields = (flags.fields || process.env.REINS_TEXT_FIELDS || "")
    .toString()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const { kind, text } = mapGeneric(payload, {
    text: typeof flags.text === "string" ? flags.text : undefined,
    kind: (typeof flags.kind === "string" && flags.kind) || process.env.REINS_KIND,
    textFields,
  });

  if (!text) process.exit(0);

  sendEvent({
    url: process.env.REINS_URL,
    key: process.env.REINS_KEY,
    project: resolveProject(payload),
    member: process.env.REINS_MEMBER || resolveMember(),
    kind,
    text,
    session: payload.session_id || payload.session,
    // Default label is "agent" so an unlabelled generic capture is still honest
    // about being non-Claude; concrete adapters override with their real id.
    source: (typeof flags.source === "string" && flags.source) || process.env.REINS_SOURCE || "agent",
    meta: { cwd: payload.cwd, event: payload.event || payload.hook_event_name || "generic" },
  }).finally(() => process.exit(0));
}
