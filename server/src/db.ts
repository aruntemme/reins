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
  source      TEXT NOT NULL DEFAULT 'claude-code',  -- which agent harness captured this
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

-- Append-only ledger of every context-pack snapshot written to 0G Storage.
-- The rollup table holds only the latest pointer per project; this keeps the
-- full history. Cross-instance sync (C) reads/writes it; chain anchoring (D)
-- fills anchored_tx with the on-chain anchor transaction.
CREATE TABLE IF NOT EXISTS snapshots (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  project      TEXT NOT NULL,
  root_hash    TEXT NOT NULL,             -- 0G Storage Merkle root (content address)
  tx_hash      TEXT NOT NULL DEFAULT '',  -- 0G Storage upload tx
  anchored_tx  TEXT NOT NULL DEFAULT '',  -- 0G Chain anchor tx (set by anchoring)
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots ON snapshots(project, created_at);
CREATE INDEX IF NOT EXISTS idx_snapshots_root ON snapshots(root_hash);

-- ── Accounts (human identity on top of workspaces) ──────────────
-- A user signs up with email + password; signup also creates their first
-- workspace and an owner membership. Tokens remain machine credentials.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,       -- normalized lowercase
  password_hash TEXT NOT NULL,             -- scrypt$salt$hash
  created_at    INTEGER NOT NULL,
  last_login    INTEGER
);

-- Which workspaces a user belongs to and with what role. A user can belong to
-- several workspaces; each workspace has at least one owner.
CREATE TABLE IF NOT EXISTS memberships (
  user_id       TEXT NOT NULL,
  workspace_id  TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member',  -- owner | admin | member
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (user_id, workspace_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_ws ON memberships(workspace_id);

-- Link-based teammate invites (no email in v1): share /join?code=<code>.
CREATE TABLE IF NOT EXISTS invites (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'member',
  code_hash    TEXT NOT NULL UNIQUE,       -- sha256 of the one-time code
  label        TEXT,
  created_by   TEXT,
  expires_at   INTEGER NOT NULL,
  accepted_by  TEXT,
  accepted_at  INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invites_code ON invites(code_hash);

-- Link-based password resets (no email in v1): share /reset?code=<code>.
CREATE TABLE IF NOT EXISTS password_resets (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  code_hash   TEXT NOT NULL UNIQUE,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_resets_code ON password_resets(code_hash);

-- ── Short-term goals (a declared layer beneath projects.goal) ────
-- Human/agent-authored objectives, distinct from the emergent 'pending' queue.
--   scope 'team'       → a common goal for the whole project (admin-authored)
--   scope 'individual' → a teammate's own goal (member = the capture identity)
-- parent_id optionally hangs an individual goal under a team goal so its items
-- roll up. Progress is derived from the checklist (goal_items); 'blocked' is an
-- explicit flag. Authorization is by the goal's project workspace, like events.
CREATE TABLE IF NOT EXISTS goals (
  id          TEXT PRIMARY KEY,
  project     TEXT NOT NULL,
  scope       TEXT NOT NULL,                 -- team | individual
  member      TEXT,                          -- null for team; member id for individual
  parent_id   TEXT,                          -- optional team-goal parent
  title       TEXT NOT NULL,
  blocked     INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT,                          -- who authored it (member/user/agent)
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_goals_project ON goals(project, scope);
CREATE INDEX IF NOT EXISTS idx_goals_parent ON goals(parent_id);

-- Checklist items for a goal. origin 'auto' marks an item the pipeline proposed
-- (Phase 2); 'human' is hand-authored. evidence holds the event id that drove a
-- completion when it came from observed activity.
CREATE TABLE IF NOT EXISTS goal_items (
  id          TEXT PRIMARY KEY,
  goal_id     TEXT NOT NULL,
  text        TEXT NOT NULL,
  done        INTEGER NOT NULL DEFAULT 0,
  origin      TEXT NOT NULL DEFAULT 'human',  -- human | auto
  evidence    TEXT,                           -- event id when completion was observed
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_goal_items ON goal_items(goal_id, position);

-- Phase 2 auto-tracking: the pipeline never edits a checklist directly. When it
-- spots that an item looks done (or a new sub-task), it files a PROPOSAL here for
-- the goal's owner to accept or dismiss. kind: check_item (tick item_id),
-- add_item (add text to goal_id), block_goal (flag goal_id blocked). evidence
-- is the event that triggered it; member is whose activity drove it.
CREATE TABLE IF NOT EXISTS goal_proposals (
  id          TEXT PRIMARY KEY,
  project     TEXT NOT NULL,
  goal_id     TEXT NOT NULL,
  item_id     TEXT,
  kind        TEXT NOT NULL,                 -- check_item | add_item | block_goal
  text        TEXT,                          -- new item text (add_item) or note
  reason      TEXT NOT NULL,                 -- why the pipeline proposed it
  evidence    TEXT,                          -- triggering event id
  member      TEXT,                          -- whose activity drove it
  status      TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | dismissed
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_goal_proposals ON goal_proposals(project, status);
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

// Source attribution: pre-source databases get the column with the historical
// default so old events read as Claude Code (the only harness before S0).
const eventCols = db.prepare("PRAGMA table_info(events)").all() as { name: string }[];
if (!eventCols.some((c) => c.name === "source")) {
  db.exec("ALTER TABLE events ADD COLUMN source TEXT NOT NULL DEFAULT 'claude-code'");
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

/**
 * Write a member's distilled state. Used by cross-instance sync (C) to merge a
 * pulled context pack: ensureMember creates the row if this instance has never
 * seen the teammate, then we UPDATE only the fields the pack carried (undefined
 * leaves the existing column untouched, so a merge never wipes local detail).
 * working_on is stored as a JSON string to match the schema.
 */
export function upsertMemberState(
  project: string,
  member: string,
  s: { name?: string; status?: string; headline?: string; goal?: string; workingOn?: string[] }
) {
  ensureMember(project, member, s.name);
  const sets: string[] = [];
  const args: any = { project, member, updated_at: now() };
  if (s.name !== undefined) {
    sets.push("display_name = @display_name");
    args.display_name = s.name;
  }
  if (s.status !== undefined) {
    sets.push("status = @status");
    args.status = s.status;
  }
  if (s.headline !== undefined) {
    sets.push("headline = @headline");
    args.headline = s.headline;
  }
  if (s.goal !== undefined) {
    sets.push("goal = @goal");
    args.goal = s.goal;
  }
  if (s.workingOn !== undefined) {
    sets.push("working_on = @working_on");
    args.working_on = JSON.stringify(s.workingOn ?? []);
  }
  sets.push("updated_at = @updated_at");
  db.prepare(
    `UPDATE members SET ${sets.join(", ")} WHERE project = @project AND member = @member`
  ).run(args);
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
  source?: string;
}): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO events (id, project, member, kind, text, session, meta, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    e.project,
    e.member,
    e.kind,
    e.text,
    e.session ?? null,
    e.meta ? JSON.stringify(e.meta) : null,
    (e.source || "claude-code").slice(0, 40),
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

// ── Snapshot ledger (history of 0G Storage context-pack writes) ──
export interface SnapshotRow {
  id: string;
  workspace_id: string;
  project: string;
  root_hash: string;
  tx_hash: string;
  anchored_tx: string;
  created_at: number;
}

/** Append a snapshot pointer to the ledger. Returns the new row id. */
export function recordSnapshot(s: {
  workspaceId?: string;
  project: string;
  rootHash: string;
  txHash?: string;
}): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO snapshots (id, workspace_id, project, root_hash, tx_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, s.workspaceId ?? "default", s.project, s.rootHash, s.txHash ?? "", now());
  return id;
}

/** Most recent snapshots for a project, newest first. */
export function listSnapshots(project: string, limit = 20): SnapshotRow[] {
  return db
    .prepare("SELECT * FROM snapshots WHERE project = ? ORDER BY created_at DESC LIMIT ?")
    .all(project, limit) as SnapshotRow[];
}

/** The latest snapshot for a project, or undefined if none recorded. */
export function latestSnapshot(project: string): SnapshotRow | undefined {
  return db
    .prepare("SELECT * FROM snapshots WHERE project = ? ORDER BY created_at DESC LIMIT 1")
    .get(project) as SnapshotRow | undefined;
}

/** Record a 0G Chain anchor tx against the most recent snapshot with this root hash. */
export function setSnapshotAnchor(rootHash: string, anchoredTx: string): boolean {
  const row = db
    .prepare("SELECT id FROM snapshots WHERE root_hash = ? ORDER BY created_at DESC LIMIT 1")
    .get(rootHash) as { id: string } | undefined;
  if (!row) return false;
  const r = db.prepare("UPDATE snapshots SET anchored_tx = ? WHERE id = ?").run(anchoredTx, row.id);
  return r.changes > 0;
}

// ── Short-term goals ──────────────────────────────────────────
export type GoalScope = "team" | "individual";

export interface GoalItemRow {
  id: string;
  goal_id: string;
  text: string;
  done: number;
  origin: string;
  evidence: string | null;
  position: number;
  created_at: number;
  updated_at: number;
}
export interface GoalRow {
  id: string;
  project: string;
  scope: GoalScope;
  member: string | null;
  parent_id: string | null;
  title: string;
  blocked: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export function createGoal(g: {
  project: string;
  scope: GoalScope;
  member?: string | null;
  parentId?: string | null;
  title: string;
  createdBy?: string | null;
}): string {
  const id = randomUUID();
  const t = now();
  db.prepare(
    `INSERT INTO goals (id, project, scope, member, parent_id, title, blocked, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
  ).run(
    id,
    g.project,
    g.scope,
    g.scope === "individual" ? g.member ?? null : null,
    g.parentId ?? null,
    g.title,
    g.createdBy ?? null,
    t,
    t
  );
  return id;
}

export function getGoal(id: string): GoalRow | undefined {
  return db.prepare("SELECT * FROM goals WHERE id = ?").get(id) as GoalRow | undefined;
}

/** The project a goal belongs to (for authorization), or null if it doesn't exist. */
export function goalProjectId(id: string): string | null {
  const row = db.prepare("SELECT project FROM goals WHERE id = ?").get(id) as { project: string } | undefined;
  return row?.project ?? null;
}

/** The goal an item belongs to (for project + scope authorization). */
export function goalItemGoal(itemId: string): GoalRow | undefined {
  return db
    .prepare("SELECT g.* FROM goal_items i JOIN goals g ON g.id = i.goal_id WHERE i.id = ?")
    .get(itemId) as GoalRow | undefined;
}

export function updateGoal(id: string, patch: { title?: string; blocked?: boolean; parentId?: string | null }): boolean {
  const sets: string[] = [];
  const args: Record<string, unknown> = { id, updated_at: now() };
  if (patch.title !== undefined) { sets.push("title = @title"); args.title = patch.title; }
  if (patch.blocked !== undefined) { sets.push("blocked = @blocked"); args.blocked = patch.blocked ? 1 : 0; }
  if (patch.parentId !== undefined) { sets.push("parent_id = @parent_id"); args.parent_id = patch.parentId; }
  if (!sets.length) return false;
  sets.push("updated_at = @updated_at");
  const r = db.prepare(`UPDATE goals SET ${sets.join(", ")} WHERE id = @id`).run(args);
  return r.changes > 0;
}

/** Delete a goal, its items, and orphan any children (parent_id → null). */
export function deleteGoal(id: string): boolean {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM goal_items WHERE goal_id = ?").run(id);
    db.prepare("UPDATE goals SET parent_id = NULL, updated_at = ? WHERE parent_id = ?").run(now(), id);
    return db.prepare("DELETE FROM goals WHERE id = ?").run(id).changes;
  });
  return tx() > 0;
}

export function addGoalItem(it: { goalId: string; text: string; origin?: string; evidence?: string | null }): string {
  const id = randomUUID();
  const t = now();
  const max = db.prepare("SELECT COALESCE(MAX(position), -1) AS m FROM goal_items WHERE goal_id = ?").get(it.goalId) as { m: number };
  db.prepare(
    `INSERT INTO goal_items (id, goal_id, text, done, origin, evidence, position, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`
  ).run(id, it.goalId, it.text, it.origin ?? "human", it.evidence ?? null, max.m + 1, t, t);
  db.prepare("UPDATE goals SET updated_at = ? WHERE id = ?").run(t, it.goalId);
  return id;
}

export function updateGoalItem(id: string, patch: { text?: string; done?: boolean; evidence?: string | null }): boolean {
  const sets: string[] = [];
  const args: Record<string, unknown> = { id, updated_at: now() };
  if (patch.text !== undefined) { sets.push("text = @text"); args.text = patch.text; }
  if (patch.done !== undefined) { sets.push("done = @done"); args.done = patch.done ? 1 : 0; }
  if (patch.evidence !== undefined) { sets.push("evidence = @evidence"); args.evidence = patch.evidence; }
  if (!sets.length) return false;
  sets.push("updated_at = @updated_at");
  const r = db.prepare(`UPDATE goal_items SET ${sets.join(", ")} WHERE id = @id`).run(args);
  if (r.changes > 0) {
    const gid = db.prepare("SELECT goal_id FROM goal_items WHERE id = ?").get(id) as { goal_id: string } | undefined;
    if (gid) db.prepare("UPDATE goals SET updated_at = ? WHERE id = ?").run(now(), gid.goal_id);
  }
  return r.changes > 0;
}

export function deleteGoalItem(id: string): boolean {
  return db.prepare("DELETE FROM goal_items WHERE id = ?").run(id).changes > 0;
}

type GoalProgress = { done: number; total: number; pct: number };
function pct(done: number, total: number): number {
  return total === 0 ? 0 : Math.round((done / total) * 100);
}
function deriveStatus(blocked: boolean, p: GoalProgress): "todo" | "in_progress" | "blocked" | "done" {
  if (blocked) return "blocked";
  if (p.total > 0 && p.done === p.total) return "done";
  if (p.done > 0) return "in_progress";
  return "todo";
}

export interface GoalView {
  id: string;
  scope: GoalScope;
  member: string | null;
  parentId: string | null;
  title: string;
  blocked: boolean;
  status: "todo" | "in_progress" | "blocked" | "done";
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  items: { id: string; text: string; done: boolean; origin: string; evidence: string | null }[];
  progress: GoalProgress; // own items only
  rollup: GoalProgress; // own + children's items (team goals); equals progress for individual
}

/**
 * Shaped goals for a project: each goal with its checklist, own progress, a
 * rolled-up progress (team goals also count parented children's items), and a
 * derived status. Sorted team-first, then by creation.
 */
export function buildGoalsView(project: string): GoalView[] {
  const goals = db
    .prepare("SELECT * FROM goals WHERE project = ? ORDER BY scope = 'team' DESC, created_at ASC")
    .all(project) as GoalRow[];
  const items = db
    .prepare("SELECT * FROM goal_items WHERE goal_id IN (SELECT id FROM goals WHERE project = ?) ORDER BY position ASC")
    .all(project) as GoalItemRow[];

  const byGoal = new Map<string, GoalItemRow[]>();
  for (const it of items) (byGoal.get(it.goal_id) ?? byGoal.set(it.goal_id, []).get(it.goal_id)!).push(it);

  const ownProgress = (gid: string): GoalProgress => {
    const its = byGoal.get(gid) ?? [];
    const done = its.filter((i) => i.done).length;
    return { done, total: its.length, pct: pct(done, its.length) };
  };
  const childrenOf = (gid: string) => goals.filter((g) => g.parent_id === gid);

  return goals.map((g) => {
    const own = ownProgress(g.id);
    // Team goals roll up their parented children's items; individual goals don't.
    let rollup = own;
    if (g.scope === "team") {
      let done = own.done, total = own.total;
      for (const child of childrenOf(g.id)) {
        const cp = ownProgress(child.id);
        done += cp.done; total += cp.total;
      }
      rollup = { done, total, pct: pct(done, total) };
    }
    return {
      id: g.id,
      scope: g.scope,
      member: g.member,
      parentId: g.parent_id,
      title: g.title,
      blocked: !!g.blocked,
      status: deriveStatus(!!g.blocked, g.scope === "team" ? rollup : own),
      createdBy: g.created_by,
      createdAt: g.created_at,
      updatedAt: g.updated_at,
      items: (byGoal.get(g.id) ?? []).map((i) => ({
        id: i.id, text: i.text, done: !!i.done, origin: i.origin, evidence: i.evidence,
      })),
      progress: own,
      rollup,
    };
  });
}

// ── Goal auto-tracking proposals (Phase 2) ────────────────────
export type GoalOpKind = "check_item" | "add_item" | "block_goal";
export interface GoalOp {
  op: GoalOpKind;
  goalId?: string;   // add_item / block_goal
  itemId?: string;   // check_item
  text?: string;     // add_item
  reason: string;
}

export interface GoalProposalRow {
  id: string;
  project: string;
  goal_id: string;
  item_id: string | null;
  kind: GoalOpKind;
  text: string | null;
  reason: string;
  evidence: string | null;
  member: string | null;
  status: string;
  created_at: number;
  updated_at: number;
}

/** Open, not-done checklist items the matcher can reason about for a member:
 *  their own individual goals plus the project's team goals. */
export function openGoalItemsForMatch(project: string, member: string): {
  itemId: string;
  goalId: string;
  goalTitle: string;
  scope: GoalScope;
  text: string;
}[] {
  return db
    .prepare(
      `SELECT i.id AS itemId, g.id AS goalId, g.title AS goalTitle, g.scope AS scope, i.text AS text
         FROM goal_items i JOIN goals g ON g.id = i.goal_id
        WHERE g.project = ? AND i.done = 0
          AND (g.scope = 'team' OR (g.scope = 'individual' AND g.member = ?))
        ORDER BY g.scope = 'team' DESC, i.position ASC`
    )
    .all(project, member) as any;
}

/** Goals (id + title) the member can have new items proposed onto. */
export function openGoalsForMatch(project: string, member: string): { id: string; title: string; scope: GoalScope }[] {
  return db
    .prepare(
      `SELECT id, title, scope FROM goals
        WHERE project = ? AND (scope = 'team' OR (scope = 'individual' AND member = ?))
        ORDER BY scope = 'team' DESC, created_at ASC`
    )
    .all(project, member) as any;
}

/** File a proposal, de-duping against an identical still-pending one. Returns the
 *  id, or null if a matching pending proposal already exists (or the target is gone). */
export function createGoalProposal(p: {
  project: string;
  goalId: string;
  itemId?: string | null;
  kind: GoalOpKind;
  text?: string | null;
  reason: string;
  evidence?: string | null;
  member?: string | null;
}): string | null {
  // Target must still exist.
  if (!getGoal(p.goalId)) return null;
  if (p.kind === "check_item" && !p.itemId) return null;
  if (p.kind === "check_item") {
    const it = db.prepare("SELECT done FROM goal_items WHERE id = ?").get(p.itemId) as { done: number } | undefined;
    if (!it || it.done) return null; // already gone or already done
  }
  const dupe = db
    .prepare(
      `SELECT id FROM goal_proposals WHERE status = 'pending' AND project = ? AND goal_id = ? AND kind = ?
         AND COALESCE(item_id,'') = COALESCE(?, '') AND COALESCE(text,'') = COALESCE(?, '')`
    )
    .get(p.project, p.goalId, p.kind, p.itemId ?? null, p.text ?? null) as { id: string } | undefined;
  if (dupe) return null;
  const id = randomUUID();
  const t = now();
  db.prepare(
    `INSERT INTO goal_proposals (id, project, goal_id, item_id, kind, text, reason, evidence, member, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).run(id, p.project, p.goalId, p.itemId ?? null, p.kind, p.text ?? null, p.reason, p.evidence ?? null, p.member ?? null, t, t);
  return id;
}

/** Turn the pipeline's goal_ops into proposals. Returns how many were filed. */
export function applyGoalOps(project: string, member: string, ops: GoalOp[], evidence?: string | null): number {
  let n = 0;
  for (const op of ops) {
    const id = createGoalProposal({
      project,
      goalId: op.goalId ?? (op.itemId ? goalItemGoal(op.itemId)?.id ?? "" : ""),
      itemId: op.itemId ?? null,
      kind: op.op,
      text: op.text ?? null,
      reason: op.reason,
      evidence: evidence ?? null,
      member,
    });
    if (id) n++;
  }
  return n;
}

export function getGoalProposal(id: string): GoalProposalRow | undefined {
  return db.prepare("SELECT * FROM goal_proposals WHERE id = ?").get(id) as GoalProposalRow | undefined;
}

/** Pending proposals for a project, shaped with the goal title + item text. */
export function listGoalProposals(project: string): {
  id: string;
  goalId: string;
  goalTitle: string;
  scope: GoalScope;
  itemId: string | null;
  itemText: string | null;
  kind: GoalOpKind;
  text: string | null;
  reason: string;
  evidence: string | null;
  member: string | null;
  createdAt: number;
}[] {
  return db
    .prepare(
      `SELECT p.id, p.goal_id AS goalId, g.title AS goalTitle, g.scope AS scope,
              p.item_id AS itemId, i.text AS itemText, p.kind, p.text, p.reason,
              p.evidence, p.member, p.created_at AS createdAt
         FROM goal_proposals p
         JOIN goals g ON g.id = p.goal_id
         LEFT JOIN goal_items i ON i.id = p.item_id
        WHERE p.project = ? AND p.status = 'pending'
        ORDER BY p.created_at ASC`
    )
    .all(project) as any;
}

/** Apply a pending proposal (tick item / add item / block goal) and mark it
 *  accepted. Returns the affected goal row, or null if not pending/missing. */
export function acceptGoalProposal(id: string): GoalRow | null {
  const p = getGoalProposal(id);
  if (!p || p.status !== "pending") return null;
  const goal = getGoal(p.goal_id);
  if (!goal) { db.prepare("UPDATE goal_proposals SET status='dismissed', updated_at=? WHERE id=?").run(now(), id); return null; }
  const tx = db.transaction(() => {
    if (p.kind === "check_item" && p.item_id) {
      db.prepare("UPDATE goal_items SET done = 1, origin = 'auto', evidence = ?, updated_at = ? WHERE id = ?")
        .run(p.evidence ?? null, now(), p.item_id);
      db.prepare("UPDATE goals SET updated_at = ? WHERE id = ?").run(now(), p.goal_id);
    } else if (p.kind === "add_item" && p.text) {
      addGoalItem({ goalId: p.goal_id, text: p.text, origin: "auto", evidence: p.evidence });
    } else if (p.kind === "block_goal") {
      db.prepare("UPDATE goals SET blocked = 1, updated_at = ? WHERE id = ?").run(now(), p.goal_id);
    }
    db.prepare("UPDATE goal_proposals SET status='accepted', updated_at=? WHERE id=?").run(now(), id);
  });
  tx();
  return goal;
}

export function dismissGoalProposal(id: string): GoalRow | null {
  const p = getGoalProposal(id);
  if (!p || p.status !== "pending") return null;
  db.prepare("UPDATE goal_proposals SET status='dismissed', updated_at=? WHERE id=?").run(now(), id);
  return getGoal(p.goal_id) ?? null;
}

export function countPendingProposals(project: string): number {
  const r = db.prepare("SELECT COUNT(*) AS n FROM goal_proposals WHERE project = ? AND status = 'pending'").get(project) as { n: number };
  return r.n;
}

// ── Workspace cleanup ─────────────────────────────────────────
/** Move every project from one workspace to another. Returns how many moved. */
export function reassignProjects(fromWs: string, toWs: string): number {
  const r = db
    .prepare("UPDATE projects SET workspace_id = ? WHERE workspace_id = ?")
    .run(toWs, fromWs);
  return r.changes;
}

/**
 * Move a single project (and its snapshot ledger) to another workspace. Child
 * rows — events, members, timeline, pending, handoffs, rollup — are keyed by
 * project id alone, so they follow without touching; only `snapshots` carries
 * its own workspace_id and is updated here. Returns false if the project or the
 * target workspace doesn't exist. Runs in one transaction.
 */
export function moveProject(projectId: string, toWs: string): boolean {
  const wsExists = db.prepare("SELECT 1 FROM workspaces WHERE id = ?").get(toWs);
  if (!wsExists) return false;
  if (!projectWorkspace(projectId)) return false;
  const tx = db.transaction(() => {
    db.prepare("UPDATE projects SET workspace_id = ?, updated_at = ? WHERE id = ?").run(toWs, now(), projectId);
    db.prepare("UPDATE snapshots SET workspace_id = ? WHERE project = ?").run(toWs, projectId);
  });
  tx();
  return true;
}

/** How many projects a workspace still owns — used to guard deletion. */
export function countProjects(workspaceId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM projects WHERE workspace_id = ?")
    .get(workspaceId) as { n: number };
  return row.n;
}

/**
 * Delete a workspace and its tokens. Refuses (returns false) while the
 * workspace still owns projects, so callers must merge/move them first and we
 * never orphan project rows.
 */
export function deleteWorkspace(id: string): boolean {
  if (countProjects(id) > 0) return false;
  db.prepare("DELETE FROM tokens WHERE workspace_id = ?").run(id);
  const r = db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
  return r.changes > 0;
}
