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
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import { redactSecrets } from "./redact.mjs";

const DEFAULT_URL = "http://localhost:4319";
const MAX_TEXT = 6000;

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

/** Pull the last assistant text block out of a Claude Code transcript jsonl. */
export function lastAssistantText(transcriptPath) {
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
  } catch {
    /* missing/partial transcript */
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
 * @param {object} [o.meta]    extra metadata (merged with {source})
 * @param {number} [o.timeoutMs=1500]
 */
export async function sendEvent(o) {
  const url = (o.url || process.env.REINS_URL || DEFAULT_URL).replace(/\/$/, "");
  const source = o.source || "claude-code";
  let text = String(o.text ?? "").trim();
  if (!text) return { ok: false, skipped: true };
  // Mask credentials before anything leaves the machine (the server masks again
  // at ingest as a backstop). Redact first, then bound the length.
  text = redactSecrets(text);
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);

  const body = JSON.stringify({
    project: o.project,
    member: o.member || resolveMember(),
    kind: o.kind || "progress",
    text,
    session: o.session,
    source,
    meta: { ...(o.meta || {}), source },
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 1500);
  try {
    const res = await fetch(`${url}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(o.key ? { "x-reins-key": o.key } : {}) },
      body,
      signal: ctrl.signal,
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, unreachable: true };
  } finally {
    clearTimeout(timer);
  }
}
