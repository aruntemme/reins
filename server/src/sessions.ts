/**
 * Agent sessions: one row per running agent (Claude Code, Codex, OpenCode, …),
 * upserted from every capture event, with a state log so active / waiting /
 * blocked time is counted from what really happened — never estimated.
 *
 *   prompt / progress / edit → working
 *   Stop                     → idle, or waiting while the session has an open question
 *   agent says blocked       → blocked
 *   SessionEnd               → ended
 *   no events for IDLE_MS    → idle (computed on read; logged at the last event
 *                              when the session is next heard from)
 */
import { db, now } from "./db.js";
import { redactSecrets } from "./redact.js";
import { bus } from "./bus.js";

const MIN = 60_000;
function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
/** A working session with no events for this long reads as idle. */
export const IDLE_MS = num("REINS_SESSION_IDLE_MS", 15 * MIN);

export type SessionState = "working" | "waiting" | "blocked" | "idle" | "ended";
export interface SessionRow {
  id: string;
  project: string;
  member: string;
  source: string;
  branch: string | null;
  worktree: string | null;
  repo_root: string | null;
  item_id: string | null;
  state: SessionState;
  state_since: number;
  last_line: string | null;
  started_at: number;
  last_seen: number;
}

// ── Noise: prompts that carry no intent never become pipeline events ──
const NOISE_PREFIXES = [
  "<task-notification>", "<system-reminder>", "<command-name>", "<command-message>", "<local-command-",
  "Caveat: The messages below",
];
const NOISE_WORDS = new Set([
  "continue", "go on", "go ahead", "ok", "okay", "yes", "y", "no", "n", "next", "check now", "status",
  "proceed", "done", "thanks",
]);

/** True for a system-injected or intent-free prompt ("ok", "continue", "<system-reminder>…"). */
export function isNoisePrompt(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return true;
  if (NOISE_PREFIXES.some((p) => t.startsWith(p))) return true;
  const word = t.toLowerCase().replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, "").replace(/\s+/g, " ");
  return !word || NOISE_WORDS.has(word);
}

// ── Capture fields (body or meta) ─────────────────────────────
export interface Capture {
  session?: string;
  source?: string;
  branch?: string;
  worktree?: string;
  repoRoot?: string;
  cwd?: string;
  event?: string;
}

const str = (v: unknown, max = 300): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;

/** The last path segment: worktrees and repo roots are stored by folder name only,
 *  so nobody's local directory layout lands on the shared board. */
export function folderName(p: string | undefined): string | undefined {
  if (!p) return undefined;
  const parts = p.replace(/\\/g, "/").replace(/\/+$/, "").split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1]!.slice(0, 120) : undefined;
}

/** Read session/source/branch/worktree/repo_root from a hook body or its meta. */
export function captureFrom(body: any): Capture {
  const meta = body?.meta && typeof body.meta === "object" ? body.meta : {};
  const pick = (k: string) => str(body?.[k]) ?? str(meta[k]);
  return {
    session: pick("session") ?? pick("session_id"),
    source: (pick("source") ?? undefined)?.slice(0, 40),
    branch: pick("branch") ?? str(meta.git?.branch),
    worktree: folderName(pick("worktree")),
    repoRoot: folderName(pick("repo_root") ?? pick("repoRoot")),
    cwd: folderName(pick("cwd")),
    event: pick("event"),
  };
}

/** First sentence of an agent's turn summary / progress line (≤140 chars, redacted). */
export function firstLine(text: string | undefined | null): string | null {
  if (!text) return null;
  const flat = redactSecrets(String(text))
    .split("\n")
    .map((l) => l.replace(/^[\s#>*\-•`]+/, "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/(\*\*|__)(.+?)\1/g, "$2") // **bold** / __bold__ → bold: the board shows plain text
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return null;
  const m = flat.match(/^(.+?[.!?])(\s|$)/);
  const s = (m ? m[1]! : flat).trim();
  return s.length > 140 ? `${s.slice(0, 139)}…` : s;
}

// ── Lookups ───────────────────────────────────────────────────
/** A session in this project by the id the hook/agent knows (raw or project-scoped). */
export function getSession(project: string, id: string): SessionRow | undefined {
  return db
    .prepare("SELECT * FROM sessions WHERE project = ? AND id IN (?, ?)")
    .get(project, id, `${project}/${id}`) as SessionRow | undefined;
}

export function getSessionById(id: string): SessionRow | undefined {
  return db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
}

/** The stored id for a raw session id: the raw id, unless another project already
 *  holds it (fallback ids can repeat across projects), then project-scoped. */
function storedId(project: string, raw: string): string {
  const row = db.prepare("SELECT project FROM sessions WHERE id = ?").get(raw) as { project: string } | undefined;
  return !row || row.project === project ? raw : `${project}/${raw}`;
}

export const effectiveState = (s: Pick<SessionRow, "state" | "last_seen">, at = now()): SessionState =>
  s.state === "working" && at - s.last_seen > IDLE_MS ? "idle" : s.state;

export const effectiveSince = (s: SessionRow, at = now()): number =>
  s.state === "working" && at - s.last_seen > IDLE_MS ? s.last_seen : s.state_since;

/** Does this session have an open question/decision it asked? */
function hasOpenAsk(sessionId: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM posts WHERE session_id = ? AND kind IN ('question','decision') AND status = 'open' LIMIT 1")
    .get(sessionId);
}

function logState(s: { id: string; project: string; member: string; state: string; item_id: string | null }, at: number) {
  db.prepare("INSERT INTO session_states (session_id, project, member, state, item_id, at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(s.id, s.project, s.member, s.state, s.item_id, at);
}

/** An open item in the project on this branch (the owner's first), for auto-attach. */
function itemForBranch(project: string, member: string, branch: string): string | null {
  const row = db
    .prepare(
      `SELECT id FROM goals WHERE project = ? AND scope = 'individual' AND branch = ? AND status != 'done'
        ORDER BY member = ? DESC, updated_at DESC LIMIT 1`
    )
    .get(project, branch, member) as { id: string } | undefined;
  return row?.id ?? null;
}

/** An item a session starts working on moves from open to doing. */
function startItem(itemId: string, at: number) {
  db.prepare("UPDATE goals SET status = 'doing', status_at = ?, updated_at = ? WHERE id = ? AND status = 'open'").run(at, at, itemId);
}

export type Transition = "working" | "stop" | "blocked" | "waiting" | "ended" | "seen";

/**
 * Upsert the session behind a capture event and move its state. Returns the row
 * and whether its state or item changed (callers emit on the bus).
 */
export function recordSession(
  project: string,
  member: string,
  cap: Capture,
  transition: Transition,
  opts: { lastLine?: string | null; at?: number } = {}
): { session: SessionRow; changed: boolean } {
  const at = opts.at ?? now();
  const source = cap.source || "claude-code";
  const raw = (cap.session || `${source}:${member}:${cap.worktree || cap.cwd || "default"}`).slice(0, 200);
  const id = storedId(project, raw);
  let s = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  if (!s) {
    db.prepare(
      `INSERT INTO sessions (id, project, member, source, state, state_since, started_at, last_seen)
       VALUES (?, ?, ?, ?, 'idle', ?, ?, ?)`
    ).run(id, project, member, source, at, at, at);
    s = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow;
  }
  const before = { state: s.state, item: s.item_id };
  // A working session that went quiet stopped at its last event, not now.
  let state: SessionState = s.state;
  if (state === "working" && at - s.last_seen > IDLE_MS) {
    logState({ ...s, state: "idle" }, s.last_seen);
    state = "idle";
  }
  if (transition === "working") state = "working";
  else if (transition === "stop") state = hasOpenAsk(id) ? "waiting" : "idle";
  else if (transition === "blocked" || transition === "waiting" || transition === "ended") state = transition;

  const branch = cap.branch ?? s.branch;
  let itemId = s.item_id;
  if (!itemId && branch && state !== "ended") itemId = itemForBranch(project, member, branch);

  const changed = state !== before.state || itemId !== before.item;
  const stateSince = state !== s.state ? at : s.state_since;
  db.prepare(
    `UPDATE sessions SET member = ?, source = ?, branch = ?, worktree = ?, repo_root = ?, item_id = ?,
            state = ?, state_since = ?, last_line = ?, last_seen = ? WHERE id = ?`
  ).run(
    member, source, branch ?? null, cap.worktree ?? s.worktree, cap.repoRoot ?? s.repo_root, itemId,
    state, stateSince, opts.lastLine ?? s.last_line, Math.max(at, s.last_seen), id
  );
  if (changed) logState({ id, project, member, state, item_id: itemId }, at);
  if (itemId && itemId !== before.item) startItem(itemId, at);
  if (changed) bus.emitChange({ type: "work.changed", project });
  return { session: db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow, changed };
}

/** Move a known session to a state (agent API: blocked / waiting / working). */
export function setSessionState(s: SessionRow, state: SessionState, at = now()): void {
  recordSession(s.project, s.member, { session: s.id, source: s.source }, state === "idle" ? "stop" : (state as Transition), { at });
}

/** Attach (or detach with null) a session to an item. */
export function attachSession(s: SessionRow, itemId: string | null, at = now()): void {
  if (s.item_id === itemId) return;
  db.prepare("UPDATE sessions SET item_id = ?, last_seen = MAX(last_seen, ?) WHERE id = ?").run(itemId, at, s.id);
  logState({ ...s, item_id: itemId, state: effectiveState(s, at) }, at);
  if (itemId) startItem(itemId, at);
  bus.emitChange({ type: "work.changed", project: s.project });
}

/** After a question is answered: a session waiting only on it goes back to idle. */
export function settleWaiting(sessionId: string | null, at = now()): void {
  if (!sessionId) return;
  const s = getSessionById(sessionId);
  if (s && s.state === "waiting" && !hasOpenAsk(s.id)) {
    db.prepare("UPDATE sessions SET state = 'idle', state_since = ? WHERE id = ?").run(at, s.id);
    logState({ ...s, state: "idle" }, at);
  }
}

/** The session an agent call means: an explicit id (must be this member's), else the
 *  member's most recently seen session in the project — in the same worktree and
 *  from the same agent when those are known — within the last day. */
export function resolveAgentSession(
  project: string,
  member: string,
  q: { session?: string; source?: string; worktree?: string },
  at = now()
): { session: SessionRow | null; error?: string } {
  if (q.session && q.session !== "current") {
    // A fallback id built client-side from the full worktree path
    // ("codex:ravi:/Users/ravi/app") names the stored "codex:ravi:app".
    const m = q.session.match(/^([^:]+):([^:]+):(.*\/.*)$/);
    const s = getSession(project, q.session) ?? (m ? getSession(project, `${m[1]}:${m[2]}:${folderName(m[3]) ?? "default"}`) : undefined);
    if (!s) return { session: null };
    if (s.member !== member) return { session: null, error: "that session belongs to another teammate" };
    return { session: s };
  }
  const where = ["project = ?", "member = ?", "state != 'ended'", "last_seen >= ?"];
  const args: unknown[] = [project, member, at - DAY];
  if (q.source) { where.push("source = ?"); args.push(q.source); }
  if (q.worktree) { where.push("worktree = ?"); args.push(q.worktree); }
  const row = db.prepare(`SELECT * FROM sessions WHERE ${where.join(" AND ")} ORDER BY last_seen DESC LIMIT 1`).get(...args) as SessionRow | undefined;
  return { session: row ?? null };
}

/** Record a real edit mark for a session (from the hook's touch). */
export function recordMark(s: SessionRow, kind: "edit", path: string | null, at = now()): void {
  db.prepare("INSERT INTO session_marks (session_id, project, member, item_id, kind, path, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(s.id, s.project, s.member, s.item_id, kind, path, at);
}

// ── Segments: counted time, from the state log ─────────────────
export interface Segment {
  sessionId: string;
  member: string;
  itemId: string | null;
  state: "working" | "waiting" | "blocked";
  from: number;
  to: number;
  live: boolean;
}

/**
 * Working / waiting / blocked intervals of the project's sessions inside [from, to],
 * built from session_states. A session's open working interval ends at its last
 * event once it has gone quiet (idle-on-read), so silence is never counted.
 */
export function sessionSegments(
  project: string,
  from: number,
  to: number,
  filter: { member?: string; sessionId?: string } = {},
  at = now()
): Segment[] {
  const where: string[] = ["ss.project = ?", "ss.at < ?", "(s.last_seen >= ? OR s.state IN ('working','waiting','blocked'))"];
  const args: unknown[] = [project, to, from];
  if (filter.member) { where.push("ss.member = ?"); args.push(filter.member); }
  if (filter.sessionId) { where.push("ss.session_id = ?"); args.push(filter.sessionId); }
  const rows = db
    .prepare(
      `SELECT ss.session_id, ss.member, ss.state, ss.item_id, ss.at, s.state AS cur, s.last_seen
         FROM session_states ss JOIN sessions s ON s.id = ss.session_id
        WHERE ${where.join(" AND ")} ORDER BY ss.session_id, ss.at, ss.rowid`
    )
    .all(...args) as { session_id: string; member: string; state: string; item_id: string | null; at: number; cur: string; last_seen: number }[];
  const out: Segment[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.state !== "working" && r.state !== "waiting" && r.state !== "blocked") continue;
    const next = rows[i + 1]?.session_id === r.session_id ? rows[i + 1] : undefined;
    let end: number;
    let live = false;
    if (next) end = next.at;
    else if (r.state === "working" && at - r.last_seen > IDLE_MS) end = r.last_seen;
    else { end = at; live = true; }
    const a = Math.max(r.at, from);
    const b = Math.min(end, to);
    if (b <= a) continue;
    out.push({ sessionId: r.session_id, member: r.member, itemId: r.item_id, state: r.state, from: a, to: b, live: live && b === end });
  }
  return out;
}

// ── Days (the viewer's local calendar) ────────────────────────
export const DAY = 24 * 60 * MIN;
/** Local midnight for `t`, with tz = the client's Date#getTimezoneOffset() minutes. */
export function dayStart(t: number, tz: number): number {
  const o = tz * MIN;
  return Math.floor((t - o) / DAY) * DAY + o;
}
export function isoDate(t: number, tz: number): string {
  return new Date(t - tz * MIN).toISOString().slice(0, 10);
}
