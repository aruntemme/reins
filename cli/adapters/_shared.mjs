/**
 * Shared helpers for the agent adapters. Every adapter is a thin .mjs over
 * ../lib/capture.mjs; this file holds the bits they all need so the concrete
 * adapters stay tiny and unit-testable.
 *
 * Dependency-free: only Node built-ins, so `npx` has nothing to install.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";

/** Read and JSON-parse stdin. Returns {} on empty/invalid input (never throws). */
export function readStdinJson() {
  try {
    const raw = readFileSync(0, "utf8");
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Resolve a value from a payload by a list of candidate dot-paths, returning the
 * first non-empty string found. Used so adapters can accept a few field aliases
 * (different agent versions name things differently) without branching.
 *
 * @param {object} payload
 * @param {string[]} paths  e.g. ["prompt", "input.text", "message.content"]
 */
export function pick(payload, paths) {
  for (const path of paths) {
    let cur = payload;
    let ok = true;
    for (const seg of path.split(".")) {
      if (cur && typeof cur === "object" && seg in cur) cur = cur[seg];
      else { ok = false; break; }
    }
    if (ok && typeof cur === "string" && cur.trim()) return cur.trim();
    if (ok && typeof cur === "number") return String(cur);
  }
  return "";
}

/** Project id: explicit env, else basename of payload cwd, else cwd, else "default". */
export function resolveProject(payload = {}, env = process.env) {
  if (env.REINS_PROJECT) return env.REINS_PROJECT;
  const cwd = payload.cwd || payload.workspace || process.cwd();
  return basename(cwd) || "default";
}

/** Minimal --flag parser shared by the adapters' main blocks. */
export function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) flags[key] = true;
    else { flags[key] = next; i++; }
  }
  return flags;
}
