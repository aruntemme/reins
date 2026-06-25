#!/usr/bin/env node
/**
 * One-time fix: give the public demo its OWN workspace.
 *
 * Background: the demo access token and the real projects ended up in the same
 * workspace (b7bd80d9), so "Try the demo" handed every visitor a read key to the
 * real board. This script stands up a separate Demo workspace, mints its own
 * public access token, and moves the seeded demo projects (atlas, nimbus) into
 * it — leaving the real projects (e.g. hyrenet) alone. Revoking the old token is
 * a separate, explicit step (see the deploy notes) done after the frontend is
 * pointed at the new token.
 *
 * Run it the same way as backup-db.js — piped into the live container:
 *   ssh ... 'cd /home/ubuntu/reins && docker compose exec -T reins node' < fix-demo-workspace.js
 *
 * Idempotent: safe to run more than once. The workspace id, token hash, and
 * prefix are baked in so the frontend can ship the matching token with no
 * round-trip. The token is public by design (it ships in client JS).
 */
const Database = require("better-sqlite3");
const { randomUUID } = require("crypto");

const DB_PATH = process.env.REINS_DB || "/data/reins.db";
const DEMO_WS = "880523e5";
const DEMO_WS_NAME = "Demo";
const DEMO_TOKEN_HASH = "29a948d4c59af628d0dce76f41eb6cd4e745c9b07630ad0bab03b4ed8adf1f58";
const DEMO_TOKEN_PREFIX = "rk_access_4a3d";
const DEMO_PROJECTS = ["atlas", "nimbus"];

const db = new Database(DB_PATH);
const now = Date.now();

const tx = db.transaction(() => {
  // 1) the Demo workspace
  db.prepare("INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES (?, ?, ?)")
    .run(DEMO_WS, DEMO_WS_NAME, now);

  // 2) its own public access token (only the hash is stored, as everywhere else)
  const existing = db.prepare("SELECT id FROM tokens WHERE hash = ?").get(DEMO_TOKEN_HASH);
  if (!existing) {
    db.prepare(
      `INSERT INTO tokens (id, workspace_id, kind, hash, prefix, label, created_at)
       VALUES (?, ?, 'access', ?, ?, 'demo (public)', ?)`
    ).run(randomUUID(), DEMO_WS, DEMO_TOKEN_HASH, DEMO_TOKEN_PREFIX, now);
  }

  // 3) move the seeded demo projects (and their snapshot ledger) into Demo.
  //    Child rows (events, members, timeline, pending, handoffs, rollup) key off
  //    project id alone, so they follow automatically.
  for (const p of DEMO_PROJECTS) {
    const row = db.prepare("SELECT workspace_id FROM projects WHERE id = ?").get(p);
    if (!row) { console.log(`  skip ${p}: no such project`); continue; }
    db.prepare("UPDATE projects SET workspace_id = ?, updated_at = ? WHERE id = ?").run(DEMO_WS, now, p);
    db.prepare("UPDATE snapshots SET workspace_id = ? WHERE project = ?").run(DEMO_WS, p);
  }
});
tx();

// Verify
const wsCount = (id) => db.prepare("SELECT COUNT(*) n FROM projects WHERE workspace_id = ?").get(id).n;
console.log("  Demo workspace:", db.prepare("SELECT id, name FROM workspaces WHERE id = ?").get(DEMO_WS));
console.log("  Demo token:", db.prepare("SELECT prefix, kind, label, revoked FROM tokens WHERE hash = ?").get(DEMO_TOKEN_HASH));
console.log("  projects now:", db.prepare("SELECT id, workspace_id FROM projects ORDER BY workspace_id, id").all());
console.log(`  counts -> Demo(${DEMO_WS}): ${wsCount(DEMO_WS)} project(s)`);
console.log("  done.");
