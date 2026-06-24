import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { env } from "./env.js";

export const db = new Database(env.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS workspaces (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  id          TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind        TEXT NOT NULL,             -- ingest | access | admin
  hash        TEXT NOT NULL UNIQUE,      -- sha256 of the token (plaintext never stored)
  prefix      TEXT NOT NULL,             -- first chars, for display
  label       TEXT,
  created_at  INTEGER NOT NULL,
  last_used   INTEGER,
  revoked     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tokens_hash ON tokens(hash);

CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL DEFAULT 'default',
  name          TEXT NOT NULL,
  goal          TEXT NOT NULL DEFAULT '',
  goal_set_by   TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  project     TEXT NOT NULL,
  member      TEXT NOT NULL,
  kind        TEXT NOT NULL,              -- intent | progress | summary
  text        TEXT NOT NULL,
  session     TEXT,
  meta        TEXT,                       -- json
  significance TEXT,                      -- noise | minor | major (set by triage)
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_project ON events(project, created_at);

CREATE TABLE IF NOT EXISTS members (
  project       TEXT NOT NULL,
  member        TEXT NOT NULL,
  display_name  TEXT,
  headline      TEXT NOT NULL DEFAULT '',
  goal          TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'idle',   -- active | blocked | idle
  working_on    TEXT NOT NULL DEFAULT '[]',     -- json string[]
  last_seen     INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (project, member)
);

CREATE TABLE IF NOT EXISTS timeline (
  id          TEXT PRIMARY KEY,
  project     TEXT NOT NULL,
  member      TEXT NOT NULL,
  kind        TEXT NOT NULL,             -- did | decided | blocked | started
  summary     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_timeline ON timeline(project, member, created_at);

CREATE TABLE IF NOT EXISTS pending (
  id          TEXT PRIMARY KEY,
  project     TEXT NOT NULL,
  member      TEXT NOT NULL,             -- who surfaced it
  text        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',  -- open | claimed | done
  claimed_by  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending ON pending(project, status);

CREATE TABLE IF NOT EXISTS handoffs (
  id          TEXT PRIMARY KEY,
  project     TEXT NOT NULL,
  to_member   TEXT NOT NULL,             -- who should act
  from_member TEXT,                      -- who/what surfaced it
  kind        TEXT NOT NULL,             -- mention | collision | blocker | fyi
  text        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',  -- open | ack | resolved
  sig         TEXT NOT NULL,             -- dedup signature
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_handoffs ON handoffs(project, to_member, status);

CREATE TABLE IF NOT EXISTS rollup (
  project     TEXT PRIMARY KEY,
  summary     TEXT NOT NULL DEFAULT '',
  alignment   TEXT NOT NULL DEFAULT '',
  collisions  TEXT NOT NULL DEFAULT '[]',  -- json
  risks       TEXT NOT NULL DEFAULT '[]',  -- json
  updated_at  INTEGER NOT NULL
);
`);

// Migrate pre-auth databases: add projects.workspace_id if missing.
const projCols = db.prepare("PRAGMA table_info(projects)").all() as { name: string }[];
if (!projCols.some((c) => c.name === "workspace_id")) {
  db.exec("ALTER TABLE projects ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default'");
}

// 0G Storage provenance: each rollup snapshot is uploaded to 0G Storage and
// addressed by its Merkle root hash (+ the upload tx). These columns hold the
// latest verifiable pointer for the project's shared context.
const rollupCols = db.prepare("PRAGMA table_info(rollup)").all() as { name: string }[];
for (const [col, ddl] of [
  ["root_hash", "ALTER TABLE rollup ADD COLUMN root_hash TEXT NOT NULL DEFAULT ''"],
  ["tx_hash", "ALTER TABLE rollup ADD COLUMN tx_hash TEXT NOT NULL DEFAULT ''"],
  ["anchored_at", "ALTER TABLE rollup ADD COLUMN anchored_at INTEGER NOT NULL DEFAULT 0"],
] as const) {
  if (!rollupCols.some((c) => c.name === col)) db.exec(ddl);
}

export const now = () => Date.now();

// ── Projects ──────────────────────────────────────────────────
export function ensureProject(id: string, name?: string, workspaceId = "default") {
  const existing = db.prepare("SELECT id FROM projects WHERE id = ?").get(id);
  if (!existing) {
    db.prepare(
      "INSERT INTO projects (id, workspace_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).run(id, workspaceId, name || id, now(), now());
  }
}

/** The workspace a project belongs to, or null if it doesn't exist. */
export function projectWorkspace(id: string): string | null {
  const row = db.prepare("SELECT workspace_id FROM projects WHERE id = ?").get(id) as
    | { workspace_id: string }
    | undefined;
  return row?.workspace_id ?? null;
}

export function setGoal(project: string, goal: string, by?: string) {
  ensureProject(project);
  db.prepare(
    "UPDATE projects SET goal = ?, goal_set_by = ?, updated_at = ? WHERE id = ?"
  ).run(goal, by ?? null, now(), project);
}

export function getProject(id: string): any {
  return db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
}

export function listProjects(workspaceId?: string): any[] {
  if (workspaceId) {
    return db
      .prepare("SELECT * FROM projects WHERE workspace_id = ? ORDER BY updated_at DESC")
      .all(workspaceId);
  }
  return db.prepare("SELECT * FROM projects ORDER BY updated_at DESC").all();
}

// ── Members ───────────────────────────────────────────────────
export function ensureMember(project: string, member: string, displayName?: string) {
  ensureProject(project);
  const row = db
    .prepare("SELECT member FROM members WHERE project = ? AND member = ?")
    .get(project, member);
  if (!row) {
    db.prepare(
      `INSERT INTO members (project, member, display_name, last_seen, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(project, member, displayName ?? member, now(), now());
  } else if (displayName) {
    db.prepare(
      "UPDATE members SET display_name = ?, last_seen = ? WHERE project = ? AND member = ?"
    ).run(displayName, now(), project, member);
  }
}

export function touchMember(project: string, member: string) {
  db.prepare(
    "UPDATE members SET last_seen = ? WHERE project = ? AND member = ?"
  ).run(now(), project, member);
}

export function getMember(project: string, member: string): any {
  return db
    .prepare("SELECT * FROM members WHERE project = ? AND member = ?")
    .get(project, member);
}

export function listMembers(project: string): any[] {
  return db
    .prepare("SELECT * FROM members WHERE project = ? ORDER BY last_seen DESC")
    .all(project);
}

/** Resolve a free-text name (display name, id, or @handle) to a member id. */
export function resolveMember(project: string, name: string): string | null {
  const want = name.trim().replace(/^@/, "").toLowerCase();
  if (!want) return null;
  for (const m of listMembers(project)) {
    if (
      m.member.toLowerCase() === want ||
      (m.display_name || "").toLowerCase() === want ||
      (m.display_name || "").toLowerCase().split(/\s+/)[0] === want
    )
      return m.member;
  }
  return null;
}

// ── Events ────────────────────────────────────────────────────
export function insertEvent(e: {
  project: string;
  member: string;
  kind: string;
  text: string;
  session?: string;
  meta?: unknown;
}): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO events (id, project, member, kind, text, session, meta, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    e.project,
    e.member,
    e.kind,
    e.text,
    e.session ?? null,
    e.meta ? JSON.stringify(e.meta) : null,
    now()
  );
  return id;
}

export function setEventSignificance(id: string, sig: string) {
  db.prepare("UPDATE events SET significance = ? WHERE id = ?").run(sig, id);
}

// ── Timeline ──────────────────────────────────────────────────
export function addTimeline(project: string, member: string, kind: string, summary: string) {
  db.prepare(
    `INSERT INTO timeline (id, project, member, kind, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(randomUUID(), project, member, kind, summary, now());
}

export function recentTimeline(project: string, member: string, limit = 8): any[] {
  return db
    .prepare(
      "SELECT * FROM timeline WHERE project = ? AND member = ? ORDER BY created_at DESC LIMIT ?"
    )
    .all(project, member, limit);
}

// ── Pending ───────────────────────────────────────────────────
export function listPending(project: string): any[] {
  return db
    .prepare(
      "SELECT * FROM pending WHERE project = ? AND status != 'done' ORDER BY created_at DESC"
    )
    .all(project);
}

export function findOpenPending(project: string, member: string): any[] {
  return db
    .prepare(
      "SELECT * FROM pending WHERE project = ? AND member = ? AND status = 'open'"
    )
    .all(project, member);
}

export function upsertPending(project: string, member: string, text: string, id?: string): string {
  if (id) {
    db.prepare("UPDATE pending SET text = ?, updated_at = ? WHERE id = ?").run(
      text,
      now(),
      id
    );
    return id;
  }
  const newId = randomUUID();
  db.prepare(
    `INSERT INTO pending (id, project, member, text, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'open', ?, ?)`
  ).run(newId, project, member, text, now(), now());
  return newId;
}

export function setPendingStatus(id: string, status: string, claimedBy?: string) {
  db.prepare(
    "UPDATE pending SET status = ?, claimed_by = ?, updated_at = ? WHERE id = ?"
  ).run(status, claimedBy ?? null, now(), id);
}

// ── Handoffs / @mentions ──────────────────────────────────────
export function createHandoff(h: {
  project: string;
  toMember: string;
  fromMember?: string;
  kind: string;
  text: string;
}): string | null {
  const sig = `${h.toMember}|${h.fromMember ?? ""}|${h.kind}|${h.text.trim().slice(0, 60).toLowerCase()}`;
  // Dedup: skip if an identical handoff is already open/ack (avoids re-firing every rollup).
  const dupe = db
    .prepare("SELECT id FROM handoffs WHERE project = ? AND sig = ? AND status != 'resolved'")
    .get(h.project, sig);
  if (dupe) return null;
  const id = randomUUID();
  db.prepare(
    `INSERT INTO handoffs (id, project, to_member, from_member, kind, text, status, sig, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`
  ).run(id, h.project, h.toMember, h.fromMember ?? null, h.kind, h.text.slice(0, 300), sig, now(), now());
  return id;
}

export function listHandoffs(project: string): any[] {
  return db
    .prepare("SELECT * FROM handoffs WHERE project = ? AND status != 'resolved' ORDER BY created_at DESC")
    .all(project);
}

export function incomingHandoffs(project: string, member: string): any[] {
  return db
    .prepare(
      "SELECT * FROM handoffs WHERE project = ? AND to_member = ? AND status != 'resolved' ORDER BY created_at DESC"
    )
    .all(project, member);
}

export function setHandoffStatus(id: string, status: string) {
  db.prepare("UPDATE handoffs SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), id);
}

// ── Rollup ────────────────────────────────────────────────────
export function getRollup(project: string): any {
  return db.prepare("SELECT * FROM rollup WHERE project = ?").get(project);
}

export function saveRollup(
  project: string,
  r: { summary: string; alignment: string; collisions: unknown; risks: unknown }
) {
  db.prepare(
    `INSERT INTO rollup (project, summary, alignment, collisions, risks, updated_at)
     VALUES (@project, @summary, @alignment, @collisions, @risks, @updated_at)
     ON CONFLICT(project) DO UPDATE SET
       summary = @summary, alignment = @alignment,
       collisions = @collisions, risks = @risks, updated_at = @updated_at`
  ).run({
    project,
    summary: r.summary,
    alignment: r.alignment,
    collisions: JSON.stringify(r.collisions ?? []),
    risks: JSON.stringify(r.risks ?? []),
    updated_at: now(),
  });
}

/** Record the 0G Storage pointer for a project's latest rollup snapshot. */
export function setRollupProvenance(project: string, rootHash: string, txHash: string) {
  db.prepare(
    `UPDATE rollup SET root_hash = @root_hash, tx_hash = @tx_hash, anchored_at = @anchored_at
     WHERE project = @project`
  ).run({ project, root_hash: rootHash, tx_hash: txHash, anchored_at: now() });
}
