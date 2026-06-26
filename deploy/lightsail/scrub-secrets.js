#!/usr/bin/env node
/**
 * One-time scrub: mask any secret already stored in the live DB.
 *
 * Going forward the hook and the server ingest path redact secrets automatically
 * (see cli/lib/redact.mjs and server/src/redact.ts). This cleans up anything that
 * landed BEFORE that masking existed — across every free-text column the board
 * renders. Idempotent: re-running it is a no-op once everything is masked.
 *
 * IMPORTANT: scrubbing the DB does not un-leak a key that was already captured
 * and transmitted. Rotate any exposed credential.
 *
 * Run it like backup-db.js — piped into the live container:
 *   ssh ... 'cd /home/ubuntu/reins && docker compose exec -T reins node' < scrub-secrets.js
 *
 * The redaction rules below MIRROR cli/lib/redact.mjs — keep them in sync.
 */
const Database = require("better-sqlite3");

const MASK = "‹redacted›";
const RULES = [
  { re: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g, replace: () => "‹redacted private key›" },
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\b/g, replace: () => MASK },
  { re: /\b(sk-(?:proj-|cv-|ant-|or-|live-|test-)?|rk_(?:admin|access|ingest)_|gh[posru]_|github_pat_|xox[baprs]-|AKIA|ASIA|AIza|glpat-|hf_|shpat_|sk_live_|sk_test_|pk_live_)[A-Za-z0-9_-]{12,}/g, replace: (_m, p) => `${p}${MASK}` },
  { re: /\b(api[-_ ]?key|secret(?:[-_ ]?key)?|access[-_ ]?token|client[-_ ]?secret|auth(?:orization)?|bearer|token|password|passwd)\b(\s*(?:[:=]|is|as)\s*)(["']?)([A-Za-z0-9][A-Za-z0-9_\-./+=]{11,})\3/gi, replace: (_m, f, sep, q) => `${f}${sep}${q}${MASK}${q}` },
];
function redact(text) {
  if (!text) return text;
  let out = text;
  for (const { re, replace } of RULES) out = out.replace(re, replace);
  return out;
}

// table -> columns that hold free text the board can render.
const TARGETS = {
  events: ["text"],
  timeline: ["summary"],
  members: ["headline", "goal", "working_on"],
  pending: ["text"],
  handoffs: ["text"],
  rollup: ["summary", "alignment", "collisions", "risks"],
  projects: ["goal"],
};

const db = new Database(process.env.REINS_DB || "/data/reins.db");
let changed = 0;

const run = db.transaction(() => {
  for (const [table, cols] of Object.entries(TARGETS)) {
    const rows = db.prepare(`SELECT rowid AS __rid, ${cols.join(",")} FROM ${table}`).all();
    for (const row of rows) {
      const sets = [];
      const vals = [];
      for (const c of cols) {
        const masked = redact(row[c]);
        if (masked !== row[c]) { sets.push(`${c} = ?`); vals.push(masked); }
      }
      if (sets.length) {
        db.prepare(`UPDATE ${table} SET ${sets.join(", ")} WHERE rowid = ?`).run(...vals, row.__rid);
        changed += sets.length;
      }
    }
  }
});
run();

console.log(`  scrubbed ${changed} field(s) across ${Object.keys(TARGETS).length} tables.`);
console.log("  done. (Remember to ROTATE any key that was exposed.)");
