/**
 * Small JSON state files under ~/.reins/state (override: REINS_STATE_DIR): the
 * per-session record of what team context this session has already been shown,
 * the pre-edit check cache, and the git caches. Every read/write fails soft — a
 * missing or corrupt file just means "no state", never an error in the agent.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

export function stateDir() {
  return process.env.REINS_STATE_DIR || join(os.homedir(), ".reins", "state");
}

export function stateFile(name) {
  return join(stateDir(), name);
}

export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Write atomically (temp file + rename), so a concurrent reader never sees half a file. */
export function writeJson(file, value) {
  try {
    mkdirSync(stateDir(), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

const safe = (s) => String(s || "nosession").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);

export const sessionFile = (session) => stateFile(`s-${safe(session)}.json`);

/** Delete session files untouched for a week (cheap; run at SessionStart). */
export function pruneSessions(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  try {
    const dir = stateDir();
    for (const name of readdirSync(dir)) {
      if (!name.startsWith("s-")) continue;
      const p = join(dir, name);
      if (Date.now() - statSync(p).mtimeMs > maxAgeMs) unlinkSync(p);
    }
  } catch {
    /* no dir yet */
  }
}
