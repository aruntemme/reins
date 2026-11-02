/**
 * Owned work: items (owned features, bugs, experiments, chores), their steps,
 * optional releases, and the posts people and agents exchange about them — plus
 * the read models the workspace screens and agents use.
 *
 * Items and releases reuse the goals tables (item = scope 'individual' with
 * member = owner; release = scope 'team'). Every number here is counted from
 * stored rows — steps ticked, items done, posts, session state changes — never
 * estimated.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  db, now, listMembers, createGoal, addGoalItem, buildProfileView, projectWorkspace, resolveMember, memberCandidates,
  listGoalProposals, projectHidesBranches, getProject, ensureMember,
} from "./db.js";
import type { GoalRow } from "./db.js";
import { redactSecrets } from "./redact.js";
import { computeOverlaps } from "./collisions.js";
import {
  effectiveState, effectiveSince, sessionSegments, settleWaiting, firstLine, dayStart, isoDate, DAY, IDLE_MS,
} from "./sessions.js";
import type { SessionRow, Segment } from "./sessions.js";

export const ITEM_KINDS = ["feature", "bug", "try", "chore"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
export const ITEM_STATUSES = ["open", "doing", "waiting", "blocked", "paused", "done"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];
export const POST_KINDS = ["handover", "update", "question", "answer", "note", "review", "decision", "finding"] as const;
export type PostKind = (typeof POST_KINDS)[number];

export interface ItemRow extends GoalRow {
  kind: string | null;
  status: string;
  status_at: number | null;
  due_at: number | null;
  branch: string | null;
  done_at: number | null;
  summary: string | null;
}
export interface StepRow {
  id: string;
  goal_id: string;
  text: string;
  done: number;
  position: number;
  done_by: string | null;
  done_source: string | null;
  done_at: number | null;
  created_at: number;
}
export interface PostRow {
  id: string;
  project: string;
  item_id: string | null;
  kind: PostKind;
  author: string;
  source: string;
  session_id: string | null;
  to_member: string | null;
  reply_to: string | null;
  status: string | null;
  delegate: number;
  delegated_at: number | null;
  text: string;
  created_at: number;
  updated_at: number;
}

const HOUR = 60 * 60_000;
const MIN = 60_000;
const clip = (s: string | null | undefined, n: number) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const round1 = (ms: number) => Math.round((ms / HOUR) * 10) / 10;

export const itemKind = (it: { kind: string | null }): ItemKind =>
  (ITEM_KINDS as readonly string[]).includes(it.kind ?? "") ? (it.kind as ItemKind) : "feature";
/** Status, honouring the legacy goals.blocked flag on rows written before status existed. */
export const itemStatus = (it: ItemRow): ItemStatus =>
  it.blocked && (it.status === "open" || it.status === "doing") ? "blocked" : ((it.status as ItemStatus) || "open");

// ── Items, steps, releases ─────────────────────────────────────
export function getItem(id: string): ItemRow | undefined {
  return db.prepare("SELECT * FROM goals WHERE id = ? AND scope = 'individual'").get(id) as ItemRow | undefined;
}
export function getRelease(id: string): ItemRow | undefined {
  return db.prepare("SELECT * FROM goals WHERE id = ? AND scope = 'team'").get(id) as ItemRow | undefined;
}
export function getStep(id: string): (StepRow & { project: string }) | undefined {
  return db
    .prepare("SELECT i.*, g.project AS project FROM goal_items i JOIN goals g ON g.id = i.goal_id WHERE i.id = ? AND g.scope = 'individual'")
    .get(id) as any;
}
export function itemSteps(itemId: string): StepRow[] {
  return db.prepare("SELECT * FROM goal_items WHERE goal_id = ? ORDER BY position ASC").all(itemId) as StepRow[];
}

export function createItem(p: {
  project: string; owner: string; title: string; kind: ItemKind; releaseId?: string | null;
  steps?: string[]; branch?: string | null; createdBy?: string | null;
}): string {
  const id = createGoal({ project: p.project, scope: "individual", member: p.owner, parentId: p.releaseId ?? null, title: p.title, createdBy: p.createdBy ?? p.owner });
  db.prepare("UPDATE goals SET kind = ?, status = 'open', status_at = ?, branch = ? WHERE id = ?").run(p.kind, now(), p.branch || null, id);
  for (const text of p.steps ?? []) addGoalItem({ goalId: id, text });
  return id;
}

export function updateItem(
  it: ItemRow,
  patch: { title?: string; kind?: ItemKind; owner?: string; status?: ItemStatus; releaseId?: string | null; branch?: string | null; summary?: string | null }
): void {
  const t = now();
  const sets: string[] = ["updated_at = @t"];
  const args: Record<string, unknown> = { id: it.id, t };
  if (patch.title !== undefined) { sets.push("title = @title"); args.title = patch.title; }
  if (patch.kind !== undefined) { sets.push("kind = @kind"); args.kind = patch.kind; }
  if (patch.owner !== undefined) { sets.push("member = @owner"); args.owner = patch.owner; }
  if (patch.releaseId !== undefined) { sets.push("parent_id = @parent"); args.parent = patch.releaseId; }
  if (patch.branch !== undefined) { sets.push("branch = @branch"); args.branch = patch.branch || null; }
  if (patch.summary !== undefined) { sets.push("summary = @summary"); args.summary = patch.summary; }
  if (patch.status !== undefined && patch.status !== itemStatus(it)) {
    sets.push("status = @status", "status_at = @t", "blocked = @blocked", "done_at = @done_at");
    args.status = patch.status;
    args.blocked = patch.status === "blocked" ? 1 : 0;
    args.done_at = patch.status === "done" ? t : null;
  }
  db.prepare(`UPDATE goals SET ${sets.join(", ")} WHERE id = @id`).run(args);
}

export function tickStep(stepId: string, done: boolean, by: { member: string; source: string }): void {
  const t = now();
  db.prepare("UPDATE goal_items SET done = ?, done_by = ?, done_source = ?, done_at = ?, updated_at = ? WHERE id = ?").run(
    done ? 1 : 0, done ? by.member : null, done ? by.source : null, done ? t : null, t, stepId
  );
  db.prepare("UPDATE goals SET updated_at = ? WHERE id = (SELECT goal_id FROM goal_items WHERE id = ?)").run(t, stepId);
}

export function createRelease(p: { project: string; title: string; dueAt?: number | null; createdBy?: string | null }): string {
  const id = createGoal({ project: p.project, scope: "team", title: p.title, createdBy: p.createdBy ?? null });
  db.prepare("UPDATE goals SET due_at = ?, status = 'open', status_at = ? WHERE id = ?").run(p.dueAt ?? null, now(), id);
  return id;
}

export function updateRelease(r: ItemRow, patch: { title?: string; dueAt?: number | null; status?: "open" | "done" }): void {
  const t = now();
  const sets: string[] = ["updated_at = @t"];
  const args: Record<string, unknown> = { id: r.id, t };
  if (patch.title !== undefined) { sets.push("title = @title"); args.title = patch.title; }
  if (patch.dueAt !== undefined) { sets.push("due_at = @due"); args.due = patch.dueAt; }
  if (patch.status !== undefined && patch.status !== r.status) {
    sets.push("status = @status", "status_at = @t", "done_at = @done_at");
    args.status = patch.status;
    args.done_at = patch.status === "done" ? t : null;
  }
  db.prepare(`UPDATE goals SET ${sets.join(", ")} WHERE id = @id`).run(args);
}

// ── Posts ─────────────────────────────────────────────────────
export function getPost(id: string): PostRow | undefined {
  return db.prepare("SELECT * FROM posts WHERE id = ?").get(id) as PostRow | undefined;
}

function insertPost(p: {
  project: string; itemId?: string | null; kind: PostKind; author: string; source: string; sessionId?: string | null;
  toMember?: string | null; replyTo?: string | null; text: string;
}): PostRow {
  const id = randomUUID();
  const t = now();
  const status = p.kind === "question" || p.kind === "decision" ? "open" : null;
  db.prepare(
    `INSERT INTO posts (id, project, item_id, kind, author, source, session_id, to_member, reply_to, status, delegate, text, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
  ).run(
    id, p.project, p.itemId ?? null, p.kind, p.author, p.source.slice(0, 40), p.sessionId ?? null, p.toMember ?? null,
    p.replyTo ?? null, status, redactSecrets(p.text).slice(0, 2000), t, t
  );
  return getPost(id)!;
}

/** Answer an open question/decision: an 'answer' post back to the asker. */
export function answerQuestion(q: PostRow, a: { author: string; source: string; sessionId?: string | null; text: string }): PostRow {
  const answer = db.transaction(() => {
    const row = insertPost({ project: q.project, itemId: q.item_id, kind: "answer", author: a.author, source: a.source, sessionId: a.sessionId, toMember: q.author, replyTo: q.id, text: a.text });
    db.prepare("UPDATE posts SET status = 'answered', updated_at = ? WHERE id = ?").run(now(), q.id);
    return row;
  })();
  settleWaiting(q.session_id);
  return answer;
}

/** Settle a decision (or question) as approved / changed / dismissed, optionally with words for the asker. */
export function resolvePost(q: PostRow, status: "approved" | "changed" | "dismissed", by: { author: string; source: string }, text?: string): void {
  db.transaction(() => {
    db.prepare("UPDATE posts SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), q.id);
    if (text) insertPost({ project: q.project, itemId: q.item_id, kind: "answer", author: by.author, source: by.source, toMember: q.author, replyTo: q.id, text });
  })();
  settleWaiting(q.session_id);
}

/** The addressee lets their own agent answer; it is delivered to their sessions' next prompt. */
export function delegatePost(q: PostRow, me: string): void {
  const t = now();
  db.prepare("UPDATE posts SET delegate = 1, delegated_at = ?, to_member = COALESCE(to_member, ?), updated_at = ? WHERE id = ?").run(t, me, t, q.id);
}

/** Validate and store a post from the web or an agent. A kind 'answer' with replyTo
 *  answers that question. Finding/update notes on an item become its summary line. */
export function submitPost(
  project: string,
  input: { itemId?: string | null; kind: PostKind; text: string; toMember?: string | null; replyTo?: string | null },
  by: { author: string; source: string; sessionId?: string | null }
): { post: PostRow } | { error: string; status: number } {
  let itemId: string | null = null;
  if (input.itemId) {
    const it = getItem(input.itemId);
    if (!it || it.project !== project) return { error: "itemId must be an item in this project", status: 400 };
    itemId = it.id;
  }
  let toMember: string | null = null;
  if (input.toMember) {
    toMember = resolveTeammate(project, input.toMember);
    if (!toMember) return { error: unknownTeammate(project, input.toMember), status: 400 };
    if ((input.kind === "question" || input.kind === "decision") && toMember === by.author) {
      return { error: `"${input.toMember}" is you; ask a teammate by their member id`, status: 400 };
    }
  }
  let reply: PostRow | undefined;
  if (input.replyTo) {
    reply = getPost(input.replyTo);
    if (!reply || reply.project !== project) return { error: "replyTo must be a post in this project", status: 400 };
  }
  if (input.kind === "answer") {
    if (!reply || (reply.kind !== "question" && reply.kind !== "decision")) return { error: "an answer needs replyTo: a question or decision", status: 400 };
    if (reply.status !== "open") return { error: "that question is already settled", status: 409 };
    return { post: answerQuestion(reply, { ...by, text: input.text }) };
  }
  const post = insertPost({ project, itemId: itemId ?? reply?.item_id ?? null, kind: input.kind, author: by.author, source: by.source, sessionId: by.sessionId, toMember, replyTo: reply?.id ?? null, text: input.text });
  if (post.item_id && (input.kind === "finding" || input.kind === "update")) {
    const it = getItem(post.item_id);
    if (it) updateItem(it, { summary: firstLine(post.text) });
  }
  return { post };
}

/** Change an item's owner, with a 'handover' post to the new owner. */
export function handoverItem(it: ItemRow, to: string, by: { author: string; source: string; sessionId?: string | null }, note?: string): PostRow {
  updateItem(it, { owner: to });
  return insertPost({
    project: it.project, itemId: it.id, kind: "handover", author: by.author, source: by.source, sessionId: by.sessionId,
    toMember: to, text: note?.trim() || `Handed "${it.title}" over.`,
  });
}

/** A teammate by name: a project member, or an account in the project's workspace
 *  that hasn't run an agent here yet (added to the project's members). */
/** The error for a name that names nobody — or several people — in the project. */
export function unknownTeammate(project: string, name: string): string {
  const many = memberCandidates(project, name);
  return many.length > 1
    ? `"${name}" matches several teammates (${many.join(", ")}); use their member id`
    : `no teammate "${name}" in this project`;
}

export function resolveTeammate(project: string, name: string): string | null {
  const known = resolveMember(project, name);
  if (known) return known;
  const ws = projectWorkspace(project);
  const want = name.trim().replace(/^@/, "");
  if (!ws || !want) return null;
  const row = db
    .prepare(
      `SELECT COALESCE(m.member, u.email) AS id FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = ? AND lower(COALESCE(m.member, u.email)) = lower(?) LIMIT 1`
    )
    .get(ws, want) as { id: string } | undefined;
  if (!row) return null;
  ensureMember(project, row.id);
  return row.id;
}

// ── Leads (owners/admins of the project's workspace) ──────────
export function leadMembers(project: string): Set<string> {
  const ws = projectWorkspace(project);
  if (!ws) return new Set();
  const rows = db
    .prepare(
      `SELECT lower(COALESCE(m.member, u.email)) AS m FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = ? AND m.role IN ('owner','admin')`
    )
    .all(ws) as { m: string }[];
  return new Set(rows.map((r) => r.m));
}

// ── Read models ───────────────────────────────────────────────
export interface Who { member: string; displayName: string }
export type Tone = "calm" | "needs" | "block" | "good";
export interface Viewer { member: string; lead: boolean }

interface Snap {
  project: string;
  at: number;
  hide: boolean;
  names: Map<string, string>;
  items: ItemRow[];
  byId: Map<string, ItemRow>;
  releases: Map<string, ItemRow>;
  steps: Map<string, StepRow[]>;
  sessions: SessionRow[];
  open: PostRow[];
  leads: Set<string>;
}

function load(project: string, at = now()): Snap {
  const items = db.prepare("SELECT * FROM goals WHERE project = ? AND scope = 'individual' ORDER BY created_at ASC").all(project) as ItemRow[];
  const releases = db.prepare("SELECT * FROM goals WHERE project = ? AND scope = 'team' ORDER BY created_at ASC").all(project) as ItemRow[];
  const steps = new Map<string, StepRow[]>();
  for (const s of db
    .prepare("SELECT i.* FROM goal_items i JOIN goals g ON g.id = i.goal_id WHERE g.project = ? AND g.scope = 'individual' ORDER BY i.position ASC")
    .all(project) as StepRow[]) {
    (steps.get(s.goal_id) ?? steps.set(s.goal_id, []).get(s.goal_id)!).push(s);
  }
  const sessions = db
    .prepare("SELECT * FROM sessions WHERE project = ? AND (last_seen >= ? OR state IN ('working','waiting','blocked')) ORDER BY last_seen DESC")
    .all(project, at - 8 * DAY) as SessionRow[];
  const open = db
    .prepare("SELECT * FROM posts WHERE project = ? AND status = 'open' AND kind IN ('question','decision') ORDER BY created_at ASC")
    .all(project) as PostRow[];
  return {
    project, at, hide: projectHidesBranches(project),
    names: displayNames(listMembers(project) as { member: string; display_name: string | null }[]),
    items, byId: new Map(items.map((i) => [i.id, i])), releases: new Map(releases.map((r) => [r.id, r])),
    steps, sessions, open, leads: leadMembers(project),
  };
}

/** Display names, made unique: two people who share one (say, a repo's git user.name) get
 *  their member id's local part added, so the board never shows two indistinguishable "Dev"s. */
function displayNames(members: { member: string; display_name: string | null }[]): Map<string, string> {
  const count = new Map<string, number>();
  for (const m of members) {
    const n = (m.display_name || m.member).toLowerCase();
    count.set(n, (count.get(n) ?? 0) + 1);
  }
  return new Map(members.map((m) => {
    const n = m.display_name || m.member;
    return [m.member, (count.get(n.toLowerCase()) ?? 0) > 1 && n !== m.member ? `${n} (${m.member.split("@")[0]})` : n];
  }));
}

const who = (S: Snap, m: string): Who => ({ member: m, displayName: S.names.get(m) || m });
const isLead = (S: Snap, m: string) => S.leads.has(m.toLowerCase());
const branchOf = (S: Snap, s: { branch: string | null }) => (S.hide ? null : s.branch);
const addressed = (p: PostRow, v: Viewer | null) => !!v && (p.to_member === v.member || (!p.to_member && v.lead));

const SOURCE_LABEL: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode", aider: "Aider" };
const sourceLabel = (s: string) => SOURCE_LABEL[s] ?? s;
/** "Ravi's Codex" for an agent, "Ravi" for the web. */
const byLabel = (S: Snap, member: string, source: string) =>
  source === "web" ? who(S, member).displayName : `${who(S, member).displayName}'s ${sourceLabel(source)}`;

function postOut(S: Snap, p: PostRow) {
  return {
    id: p.id, kind: p.kind, itemId: p.item_id, itemTitle: p.item_id ? S.byId.get(p.item_id)?.title ?? null : null,
    author: who(S, p.author), source: p.source, toMember: p.to_member, to: p.to_member ? who(S, p.to_member) : null,
    replyTo: p.reply_to, status: p.status, delegate: !!p.delegate, text: p.text, createdAt: p.created_at,
  };
}

function stepCount(S: Snap, itemId: string) {
  const st = S.steps.get(itemId) ?? [];
  return { done: st.filter((s) => s.done).length, total: st.length };
}

/** An agent in a worktree: sessions that share this are one agent restarted, not several. */
const laneKey = (s: SessionRow) => `${s.member}|${s.source}|${s.worktree ?? s.branch ?? s.id}`;

/** Live agents on an item, one per agent per worktree (S.sessions is newest first). */
const liveOn = (S: Snap, itemId: string) => {
  const seen = new Set<string>();
  return S.sessions.filter((s) => {
    if (s.item_id !== itemId || effectiveState(s, S.at) === "ended" || S.at - s.last_seen >= 12 * HOUR) return false;
    const k = laneKey(s);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

function itemState(S: Snap, it: ItemRow, v: Viewer | null): { text: string; tone: Tone } {
  const status = itemStatus(it);
  if (status === "done") return { text: "done", tone: "good" };
  const asks = S.open.filter((p) => p.item_id === it.id);
  if (asks.some((p) => addressed(p, v) && p.author !== v?.member)) return { text: "waiting on you", tone: "needs" };
  const sessions = liveOn(S, it.id);
  if (status === "blocked" || sessions.some((s) => effectiveState(s, S.at) === "blocked")) {
    return { text: it.summary ? `blocked · ${clip(it.summary, 70)}` : "blocked", tone: "block" };
  }
  if (asks.length) {
    const to = asks[0]!.to_member;
    return { text: `waiting on ${to ? who(S, to).displayName : "the leads"}`, tone: "needs" };
  }
  if (status === "waiting") return { text: "waiting", tone: "needs" };
  if (status === "paused") return { text: "paused", tone: "calm" };
  const { done, total } = stepCount(S, it.id);
  if (total > 0 && done === total) return { text: "all steps done", tone: "good" };
  const working = sessions.find((s) => effectiveState(s, S.at) === "working");
  if (working) return { text: clip(it.summary || working.last_line || "working", 80), tone: "calm" };
  if (it.summary) return { text: clip(it.summary, 80), tone: "calm" };
  if (done === 0 && sessions.length === 0) return { text: "not started", tone: "calm" };
  return { text: `${done} of ${total} steps`, tone: "calm" };
}

function lane(S: Snap, it: ItemRow, v: Viewer | null) {
  const steps = stepCount(S, it.id);
  const rel = it.parent_id ? S.releases.get(it.parent_id) : undefined;
  return {
    id: it.id, title: it.title, kind: itemKind(it), owner: who(S, it.member ?? ""),
    release: rel ? { id: rel.id, title: rel.title } : null,
    steps,
    agents: liveOn(S, it.id).map((s) => ({ sessionId: s.id, source: s.source, state: effectiveState(s, S.at), at: steps.total ? steps.done / steps.total : 0 })),
    state: itemState(S, it, v),
  };
}

function kindCounts(items: ItemRow[]) {
  const c = { feature: 0, bug: 0, try: 0, chore: 0 };
  for (const it of items) c[itemKind(it)]++;
  return c;
}

/** "2 features, 1 bug" — what someone owns, counted. */
function ownsText(items: ItemRow[]): string {
  const c = kindCounts(items);
  const word: Record<ItemKind, [string, string]> = { feature: ["feature", "features"], bug: ["bug", "bugs"], try: ["experiment", "experiments"], chore: ["chore", "chores"] };
  return ITEM_KINDS.filter((k) => c[k]).map((k) => `${c[k]} ${word[k][c[k] === 1 ? 0 : 1]}`).join(", ");
}

const openItems = (S: Snap) => S.items.filter((i) => itemStatus(i) !== "done");

/** Open asks the viewer can act on: addressed to them, or to the leads when they lead. */
const asksFor = (S: Snap, v: Viewer | null) => S.open.filter((p) => addressed(p, v) && p.author !== v?.member);

function waitingOn(S: Snap, v: Viewer | null): number {
  const keys = new Set(asksFor(S, v).map((p) => p.item_id ?? `post:${p.id}`));
  return keys.size;
}

function currentRelease(S: Snap): ItemRow | null {
  const open = [...S.releases.values()].filter((r) => r.status !== "done");
  open.sort((a, b) => (a.due_at ?? Infinity) - (b.due_at ?? Infinity) || a.created_at - b.created_at);
  return open[0] ?? null;
}

/** Clips for one session's segments: each block is an item (tinted by kind), a wait, or a block. */
function clipsOf(S: Snap, segs: Segment[]) {
  const out: { itemId: string | null; label: string; kind: string; from: number; to: number | null }[] = [];
  for (const g of segs) {
    const it = g.itemId ? S.byId.get(g.itemId) : undefined;
    const kind = g.state === "waiting" ? "wait" : g.state === "blocked" ? "block" : it ? itemKind(it) : "none";
    const label = g.state === "waiting" ? "waiting" : g.state === "blocked" ? "blocked" : it ? it.title : "untracked";
    const last = out[out.length - 1];
    if (last && last.to === g.from && last.kind === kind && last.itemId === (it?.id ?? null)) {
      last.to = g.live ? null : g.to;
      continue;
    }
    out.push({ itemId: it?.id ?? null, label, kind, from: g.from, to: g.live ? null : g.to });
  }
  return out;
}

const segKind = (S: Snap, g: Segment): ItemKind | "blocked" | null => {
  if (g.state !== "working") return "blocked";
  const it = g.itemId ? S.byId.get(g.itemId) : undefined;
  return it ? itemKind(it) : null;
};

/** Agent hours per local day for [from, from + days·DAY), split by kind of work. */
function dayBuckets(S: Snap, segs: Segment[], from: number, days: number, tz: number) {
  const out: { date: string; hours: number; parts: { kind: ItemKind | "blocked"; hours: number }[] }[] = [];
  for (let d = 0; d < days; d++) {
    const a = from + d * DAY;
    const b = a + DAY;
    let total = 0;
    const parts = new Map<ItemKind | "blocked", number>();
    for (const g of segs) {
      const ms = Math.min(g.to, b) - Math.max(g.from, a);
      if (ms <= 0) continue;
      total += ms;
      const k = segKind(S, g);
      if (k) parts.set(k, (parts.get(k) ?? 0) + ms);
    }
    out.push({
      date: isoDate(a, tz), hours: round1(total),
      parts: [...parts].filter(([, ms]) => round1(ms) > 0).map(([kind, ms]) => ({ kind, hours: round1(ms) })),
    });
  }
  return out;
}

/** Blocked moments since `since`: sessions that reported blocked, and items set blocked. */
function blockedEvents(S: Snap, since: number) {
  const rows = db
    .prepare("SELECT session_id, member, item_id, at FROM session_states WHERE project = ? AND state = 'blocked' AND at >= ? ORDER BY at ASC")
    .all(S.project, since) as { session_id: string; member: string; item_id: string | null; at: number }[];
  const seen = new Set<string>();
  const out: { key: string; at: number; member: string; itemId: string | null; source: string | null }[] = [];
  const src = new Map(S.sessions.map((s) => [s.id, s.source]));
  for (const r of rows) {
    const key = r.item_id ?? `s:${r.session_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, at: r.at, member: r.member, itemId: r.item_id, source: src.get(r.session_id) ?? null });
  }
  for (const it of S.items) {
    if (itemStatus(it) !== "blocked" || (it.status_at ?? 0) < since || seen.has(it.id)) continue;
    seen.add(it.id);
    out.push({ key: it.id, at: it.status_at ?? it.updated_at, member: it.member ?? "", itemId: it.id, source: null });
  }
  return out;
}

function overlapsOut(S: Snap) {
  return computeOverlaps(S.project, S.at)
    .filter((o) => o.kind === "file")
    .map((o) => {
      const r = db
        .prepare(`SELECT MAX(created_at) AS t FROM file_touches WHERE project = ? AND lower(path) = ? AND member IN (${o.members.map(() => "?").join(",")})`)
        .get(S.project, o.area, ...o.members) as { t: number | null };
      return { members: o.members.map((m) => who(S, m)), path: o.area, at: r.t ?? S.at };
    });
}

function needsFor(S: Snap, v: Viewer | null) {
  const needs: any[] = [];
  const sess = new Map(S.sessions.map((s) => [s.id, s]));
  const itemRef = (id: string | null) => {
    const it = id ? S.byId.get(id) : undefined;
    return it ? { id: it.id, title: it.title } : null;
  };
  for (const p of asksFor(S, v)) {
    const s = p.session_id ? sess.get(p.session_id) : undefined;
    needs.push({
      id: p.id, type: p.kind, text: p.text,
      meta: [itemRef(p.item_id)?.title, s ? branchOf(S, s) : null].filter(Boolean).join(" · "),
      item: itemRef(p.item_id), from: { ...who(S, p.author), source: p.source }, at: p.created_at, postId: p.id, sessionId: p.session_id,
    });
  }
  const blockedItems = new Set<string>();
  for (const s of S.sessions) {
    if (effectiveState(s, S.at) !== "blocked") continue;
    const it = s.item_id ? S.byId.get(s.item_id) : undefined;
    if (it) blockedItems.add(it.id);
    needs.push({
      id: `blocked:${s.id}`, type: "blocked",
      text: it?.summary || s.last_line || `${byLabel(S, s.member, s.source)} is blocked`,
      meta: [it?.title, branchOf(S, s)].filter(Boolean).join(" · "),
      item: itemRef(s.item_id), from: { ...who(S, s.member), source: s.source }, at: s.state_since, postId: null, sessionId: s.id,
    });
  }
  for (const it of openItems(S)) {
    if (itemStatus(it) !== "blocked" || blockedItems.has(it.id)) continue;
    needs.push({
      id: `blocked:${it.id}`, type: "blocked", text: it.summary || `${it.title} is blocked`, meta: it.title,
      item: { id: it.id, title: it.title }, from: { ...who(S, it.member ?? ""), source: "web" }, at: it.status_at ?? it.updated_at, postId: null, sessionId: null,
    });
  }
  for (const o of overlapsOut(S)) {
    const first = o.members[0]!;
    const src = S.sessions.find((s) => s.member === first.member)?.source ?? "web";
    needs.push({
      id: `overlap:${o.path}`, type: "overlap", text: `${o.members.map((m) => m.displayName).join(" and ")} are both in ${o.path}`,
      meta: o.path, item: null, from: { ...first, source: src }, at: o.at, postId: null, sessionId: null,
    });
  }
  return needs.sort((a, b) => a.at - b.at);
}

function tapeSince(S: Snap, since: number) {
  const tape: { at: number; kind: string; text: string }[] = [];
  const posts = db
    .prepare("SELECT * FROM posts WHERE project = ? AND (created_at >= ? OR delegated_at >= ?) ORDER BY created_at DESC LIMIT 200")
    .all(S.project, since, since) as PostRow[];
  const byPost = new Map(posts.map((p) => [p.id, p]));
  const askerOf = (p: PostRow) => {
    const q = p.reply_to ? byPost.get(p.reply_to) ?? getPost(p.reply_to) : undefined;
    return q ? who(S, q.author).displayName : "a teammate";
  };
  for (const p of posts) {
    if (p.created_at >= since) {
      const by = byLabel(S, p.author, p.source);
      const t = clip(p.text, 140);
      if (p.kind === "question" || p.kind === "decision") tape.push({ at: p.created_at, kind: "Asked", text: `${by} asked ${p.to_member ? who(S, p.to_member).displayName : "the leads"}: ${t}` });
      else if (p.kind === "answer") tape.push({ at: p.created_at, kind: "Answered", text: `${by} answered ${askerOf(p)}: ${t}` });
      else if (p.kind === "finding") tape.push({ at: p.created_at, kind: "Finding", text: `${by}: ${t}` });
      else if (p.kind === "handover") {
        const title = p.item_id ? S.byId.get(p.item_id)?.title : null;
        tape.push({ at: p.created_at, kind: "Handed over", text: `${by} handed ${title ? `${title} ` : ""}to ${p.to_member ? who(S, p.to_member).displayName : "a teammate"}` });
      }
    }
    if (p.delegate && p.delegated_at && p.delegated_at >= since) {
      tape.push({ at: p.delegated_at, kind: "Delegated", text: `${who(S, p.to_member ?? "").displayName} let their agent answer ${who(S, p.author).displayName}: ${clip(p.text, 100)}` });
    }
  }
  for (const it of S.items) {
    if (it.done_at && it.done_at >= since) tape.push({ at: it.done_at, kind: "Done", text: `${who(S, it.member ?? "").displayName} finished ${it.title}` });
  }
  for (const b of blockedEvents(S, since)) {
    const it = b.itemId ? S.byId.get(b.itemId) : undefined;
    const by = b.source ? byLabel(S, b.member, b.source) : who(S, b.member).displayName;
    tape.push({ at: b.at, kind: "Blocked", text: `${it ? `${it.title}: ` : ""}${by} is blocked${it?.summary ? ` — ${clip(it.summary, 100)}` : ""}` });
  }
  return tape.sort((a, b) => b.at - a.at).slice(0, 30);
}

function traitsOf(project: string, member: string) {
  return buildProfileView(project, member).map((t) => ({ text: t.statement, why: t.observations === 1 ? "seen once" : `seen ${t.observations} times` }));
}

/** Members worth showing: active in the last week, or owning open work. */
function teamMembers(S: Snap, since: number): string[] {
  const set = new Set<string>();
  for (const it of openItems(S)) if (it.member) set.add(it.member);
  for (const s of S.sessions) if (s.last_seen >= since) set.add(s.member);
  for (const it of S.items) if (it.member && it.done_at && it.done_at >= since) set.add(it.member);
  return [...set].sort((a, b) => who(S, a).displayName.localeCompare(who(S, b).displayName));
}

/** Hour-aligned bounds around the day's activity, for the per-agent tracks. */
function trackBounds(segs: Segment[], since: number, at: number, tz: number) {
  const o = tz * MIN;
  const floorH = (t: number) => Math.floor((t - o) / HOUR) * HOUR + o;
  const first = segs.length ? Math.min(...segs.map((g) => g.from)) : at - HOUR;
  return { from: Math.max(since, floorH(first)), to: floorH(at) + HOUR };
}

/** questions answered (and decisions approved/changed) since */
function settledSince(project: string, since: number): number {
  const r = db
    .prepare("SELECT COUNT(*) AS n FROM posts WHERE project = ? AND kind IN ('question','decision') AND status IN ('answered','approved','changed') AND updated_at >= ?")
    .get(project, since) as { n: number };
  return r.n;
}

export interface ViewOpts { tz: number; since?: number }

export function todayView(project: string, viewer: { member: string; role?: string }, opts: ViewOpts) {
  const at = now();
  const S = load(project, at);
  const v: Viewer = { member: viewer.member, lead: viewer.role === "owner" || viewer.role === "admin" || isLead(S, viewer.member) };
  const since = opts.since ?? dayStart(at, opts.tz);
  const open = openItems(S);
  const rel = currentRelease(S);
  const segs = sessionSegments(project, since, at, {}, at);
  const bySession = new Map<string, Segment[]>();
  for (const g of segs) (bySession.get(g.sessionId) ?? bySession.set(g.sessionId, []).get(g.sessionId)!).push(g);
  const sessById = new Map(S.sessions.map((s) => [s.id, s]));

  const untracked = S.sessions
    .filter((s) => !s.item_id && effectiveState(s, at) !== "ended" && at - s.last_seen <= 2 * IDLE_MS)
    .map((s) => {
      const ms = (bySession.get(s.id) ?? []).filter((g) => g.state === "working" && !g.itemId).reduce((n, g) => n + g.to - g.from, 0);
      const headline = (db.prepare("SELECT headline FROM members WHERE project = ? AND member = ?").get(project, s.member) as { headline?: string } | undefined)?.headline;
      return { sessionId: s.id, member: who(S, s.member), source: s.source, text: s.last_line || headline || "", minutes: Math.round(ms / MIN) };
    })
    .filter((u) => u.minutes >= 1);

  const bounds = trackBounds(segs, since, at, opts.tz);
  // One row per agent per worktree: a person restarting their agent (a new session each
  // time) stays on one row instead of stacking a fresh row per session.
  const lanes = new Map<string, { s: SessionRow; segs: Segment[] }>();
  for (const id of bySession.keys()) {
    const s = sessById.get(id) ?? (db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined);
    if (!s) continue;
    const k = laneKey(s);
    const cur = lanes.get(k);
    if (!cur) lanes.set(k, { s, segs: [...bySession.get(id)!] });
    else {
      cur.segs.push(...bySession.get(id)!);
      if (s.last_seen > cur.s.last_seen) cur.s = s; // the row shows the latest session's branch
    }
  }
  const rows = [...lanes.values()]
    .sort((a, b) => who(S, a.s.member).displayName.localeCompare(who(S, b.s.member).displayName) || a.s.started_at - b.s.started_at)
    .map(({ s, segs: g }) => ({ sessionId: s.id, who: who(S, s.member), source: s.source, branch: branchOf(S, s), worktree: s.worktree, clips: clipsOf(S, g.sort((x, y) => x.from - y.from)) }));

  const weekAgo = at - 7 * DAY;
  return {
    now: at,
    project: { id: project, name: getProject(project)?.name ?? project },
    viewer: { ...who(S, viewer.member), role: viewer.role ?? "member" },
    counts: { ...kindCounts(open), waitingOnViewer: waitingOn(S, v) },
    since: { tasksDone: S.items.filter((i) => i.done_at && i.done_at >= since).length, questionsSettled: settledSince(project, since), blocked: blockedEvents(S, since).length },
    release: rel
      ? { id: rel.id, title: rel.title, dueAt: rel.due_at, items: S.items.filter((i) => i.parent_id === rel.id).map((i) => { const st = itemState(S, i, v); return { id: i.id, title: i.title, stateText: st.text, tone: st.tone }; }) }
      : null,
    groups: [
      { kind: "feature", items: open.filter((i) => itemKind(i) === "feature").map((i) => lane(S, i, v)) },
      { kind: "bug", items: open.filter((i) => itemKind(i) === "bug").map((i) => lane(S, i, v)) },
      { kind: "try_chore", items: open.filter((i) => itemKind(i) === "try" || itemKind(i) === "chore").map((i) => lane(S, i, v)) },
    ],
    untracked,
    tracks: { from: bounds.from, to: bounds.to, now: at, rows, overlaps: overlapsOut(S) },
    needs: needsFor(S, v),
    tape: tapeSince(S, since),
    people: teamMembers(S, weekAgo).map((m) => {
      const mine = open.filter((i) => i.member === m);
      return {
        who: who(S, m), owns: kindCounts(mine),
        done7d: S.items.filter((i) => i.member === m && i.done_at && i.done_at >= weekAgo).length,
        style: buildProfileView(project, m)[0]?.statement ?? "",
      };
    }),
  };
}

export function meView(project: string, viewer: { member: string; role?: string }, opts: ViewOpts) {
  const at = now();
  const S = load(project, at);
  const me = viewer.member;
  const v: Viewer = { member: me, lead: viewer.role === "owner" || viewer.role === "admin" || isLead(S, me) };
  const since = opts.since ?? dayStart(at, opts.tz);
  const mineOpen = openItems(S).filter((i) => i.member === me);

  const leads = [...S.leads];
  const forYou = (db
    .prepare(
      `SELECT * FROM posts WHERE project = @p AND (
          (kind IN ('question','decision') AND status = 'open' AND author != @me AND (to_member = @me OR (to_member IS NULL AND @lead = 1)))
       OR (kind = 'handover' AND to_member = @me AND created_at >= @week)
       OR (kind = 'note' AND author != @me AND created_at >= @day AND (to_member = @me OR (to_member IS NULL AND lower(author) IN (SELECT value FROM json_each(@leads)))))
       OR (kind = 'answer' AND created_at >= @day AND reply_to IN (SELECT id FROM posts WHERE project = @p AND author = @me))
       ) ORDER BY created_at DESC LIMIT 50`
    )
    .all({ p: project, me, lead: v.lead ? 1 : 0, week: at - 7 * DAY, day: at - DAY, leads: JSON.stringify(leads) }) as PostRow[]).map((p) => postOut(S, p));

  const mySessions = S.sessions.filter((s) => s.member === me && (s.last_seen >= since || ["working", "waiting", "blocked"].includes(effectiveState(s, at))));
  const segs = sessionSegments(project, since, at, { member: me }, at);
  // One entry per agent per worktree; its restarts (new sessions) merge into it. mySessions is
  // newest first, so the first session of a lane is the one whose state and last line show.
  const lanes = new Map<string, SessionRow[]>();
  for (const s of mySessions) (lanes.get(laneKey(s)) ?? lanes.set(laneKey(s), []).get(laneKey(s))!).push(s);
  const agents = [...lanes.values()].map((group) => {
    const s = group[0]!;
    const ids = new Set(group.map((x) => x.id));
    const inList = group.map(() => "?").join(",");
    const it = s.item_id ? S.byId.get(s.item_id) : undefined;
    const marks = db.prepare(`SELECT at, kind FROM session_marks WHERE session_id IN (${inList}) AND at >= ? ORDER BY at ASC LIMIT 300`).all(...ids, since) as { at: number; kind: string }[];
    const asks = db.prepare(`SELECT created_at AS at FROM posts WHERE session_id IN (${inList}) AND kind IN ('question','decision') AND created_at >= ?`).all(...ids, since) as { at: number }[];
    return {
      sessionId: s.id, source: s.source, branch: branchOf(S, s), worktree: s.worktree, item: it ? { id: it.id, title: it.title } : null,
      state: effectiveState(s, at), stateSince: effectiveSince(s, at), lastLine: s.last_line,
      clips: clipsOf(S, segs.filter((g) => ids.has(g.sessionId)).sort((a, b) => a.from - b.from)),
      steps: [...marks.map((m) => ({ at: m.at, kind: m.kind })), ...asks.map((a) => ({ at: a.at, kind: "ask" }))].sort((a, b) => a.at - b.at),
    };
  });

  return {
    me: who(S, me),
    counts: { ...kindCounts(mineOpen), waitingOnViewer: waitingOn(S, v) },
    forYou,
    agents,
    around: aroundMe(S, me),
    owned: mineOpen.map((i) => lane(S, i, v)),
    traits: traitsOf(project, me),
  };
}

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/** Teammates near the viewer's work: the same file, or the same folder (last 24h of edits). */
function aroundMe(S: Snap, me: string) {
  const touches = db.prepare("SELECT member, path, created_at FROM file_touches WHERE project = ? AND created_at >= ?").all(S.project, S.at - DAY) as {
    member: string; path: string; created_at: number;
  }[];
  const mine = touches.filter((t) => t.member === me);
  if (!mine.length) return [];
  const myFiles = new Set(mine.map((t) => t.path.toLowerCase()));
  const myDirs = new Set(mine.map((t) => dirOf(t.path.toLowerCase())).filter(Boolean));
  const out = new Map<string, { who: Who; text: string; meta: string; tone: Tone }>();
  const itemOf = (m: string) => {
    const s = S.sessions.find((x) => x.member === m && x.item_id && effectiveState(x, S.at) !== "ended");
    return s?.item_id ? S.byId.get(s.item_id)?.title ?? "" : "";
  };
  for (const t of touches.sort((a, b) => b.created_at - a.created_at)) {
    if (t.member === me) continue;
    const p = t.path.toLowerCase();
    const prev = out.get(t.member);
    if (myFiles.has(p) && prev?.tone !== "needs") {
      out.set(t.member, { who: who(S, t.member), text: `also edited ${t.path}`, meta: itemOf(t.member), tone: "needs" });
    } else if (!prev && myDirs.has(dirOf(p))) {
      out.set(t.member, { who: who(S, t.member), text: `works in ${dirOf(t.path)}/`, meta: itemOf(t.member), tone: "calm" });
    }
  }
  return [...out.values()].sort((a, b) => (a.tone === "needs" ? 0 : 1) - (b.tone === "needs" ? 0 : 1)).slice(0, 6);
}

/** Teammates' questions this member's agents answered (helped), and the questions they asked, in a window. */
function helpCounts(project: string, member: string, from: number) {
  const helped = (db
    .prepare(
      `SELECT COUNT(*) AS n FROM posts a JOIN posts q ON q.id = a.reply_to
        WHERE a.project = ? AND a.kind = 'answer' AND a.source != 'web' AND a.author = ? AND q.author != ? AND a.created_at >= ?`
    )
    .get(project, member, member, from) as { n: number }).n;
  const asked = db
    .prepare(
      `SELECT q.created_at AS asked, (SELECT MIN(a.created_at) FROM posts a WHERE a.reply_to = q.id AND a.kind = 'answer') AS answered
         FROM posts q WHERE q.project = ? AND q.author = ? AND q.kind IN ('question','decision') AND q.created_at >= ?`
    )
    .all(project, member, from) as { asked: number; answered: number | null }[];
  const waits = asked.filter((a) => a.answered).map((a) => (a.answered! - a.asked) / MIN).sort((a, b) => a - b);
  const median = waits.length ? (waits.length % 2 ? waits[(waits.length - 1) / 2]! : (waits[waits.length / 2 - 1]! + waits[waits.length / 2]!) / 2) : null;
  return { helped, asked: asked.length, askMedianMin: median === null ? null : Math.round(median) };
}

export function weekView(project: string, days: number, opts: ViewOpts) {
  const at = now();
  const S = load(project, at);
  const from = dayStart(at, opts.tz) - (days - 1) * DAY;
  const segs = sessionSegments(project, from, at, {}, at);
  const working = segs.filter((g) => g.state === "working");
  const activeMs = working.reduce((n, g) => n + g.to - g.from, 0);
  const mixMs = { feature: 0, bug: 0, try: 0, chore: 0 };
  for (const g of working) {
    const k = segKind(S, g);
    if (k && k !== "blocked") mixMs[k] += g.to - g.from;
  }
  const pctOf = (ms: number) => (activeMs ? Math.round((ms / activeMs) * 100) : 0);
  const doneIn = (i: ItemRow) => !!i.done_at && i.done_at >= from;

  const owned = S.items
    .filter((i) => itemStatus(i) !== "done" || doneIn(i))
    .map((i) => {
      const st = S.steps.get(i.id) ?? [];
      const perDay = Array.from({ length: days }, (_, d) =>
        st.filter((s) => s.done && s.done_at && s.done_at >= from + d * DAY && s.done_at < from + (d + 1) * DAY).length
      );
      const state = itemState(S, i, null);
      return {
        id: i.id, title: i.title, kind: itemKind(i), owner: who(S, i.member ?? ""), stateText: state.text, tone: state.tone,
        before: st.filter((s) => s.done && (!s.done_at || s.done_at < from)).length,
        now: st.filter((s) => s.done).length, total: st.length, perDay,
      };
    });

  const bySegMember = new Map<string, Segment[]>();
  for (const g of segs) (bySegMember.get(g.member) ?? bySegMember.set(g.member, []).get(g.member)!).push(g);
  const people = [...bySegMember.keys()]
    .sort((a, b) => who(S, a).displayName.localeCompare(who(S, b).displayName))
    .map((m) => {
      const mine = bySegMember.get(m)!;
      const lane = new Map(S.sessions.map((s) => [s.id, laneKey(s)]));
      return { who: who(S, m), agents: new Set(mine.map((g) => lane.get(g.sessionId) ?? g.sessionId)).size, days: dayBuckets(S, mine, from, days, opts.tz) };
    });

  const tableMembers = [...new Set([...bySegMember.keys(), ...teamMembers(S, from)])].sort((a, b) => who(S, a).displayName.localeCompare(who(S, b).displayName));
  const table = tableMembers.map((m) => {
    const blockedMs = (bySegMember.get(m) ?? []).filter((g) => g.state !== "working").reduce((n, g) => n + g.to - g.from, 0);
    return {
      who: who(S, m),
      done: S.items.filter((i) => i.member === m && doneIn(i)).length,
      owns: ownsText(openItems(S).filter((i) => i.member === m)),
      blockedHours: round1(blockedMs),
      helped: helpCounts(project, m, from).helped,
    };
  });

  // Factual observations from the numbers above (may be empty).
  const look: { text: string; why: string }[] = [];
  const blockedByItem = new Map<string, number>();
  for (const g of segs) if (g.state !== "working" && g.itemId) blockedByItem.set(g.itemId, (blockedByItem.get(g.itemId) ?? 0) + g.to - g.from);
  for (const [id, ms] of [...blockedByItem].sort((a, b) => b[1] - a[1]).slice(0, 2)) {
    const it = S.byId.get(id);
    if (it && ms >= HOUR) look.push({ text: `${it.title} spent ${round1(ms)}h blocked or waiting.`, why: "counted from its agents' session states" });
  }
  for (const o of owned) {
    const it = S.byId.get(o.id)!;
    if (o.tone === "good" || itemStatus(it) === "done" || o.total === 0 || it.created_at > from) continue;
    if (o.perDay.every((n) => n === 0) && o.now < o.total) look.push({ text: `${o.title} has not moved in ${days} days.`, why: `no steps ticked since ${isoDate(from, opts.tz)}` });
  }
  const topHelper = table.filter((t) => t.helped > 0).sort((a, b) => b.helped - a.helped)[0];
  if (topHelper) look.push({ text: `${topHelper.who.displayName}'s agents answered ${topHelper.helped} question${topHelper.helped === 1 ? "" : "s"} from teammates' agents.`, why: "answers to other people's questions this week" });

  return {
    from, to: at,
    tasksDone: S.items.filter(doneIn).length,
    mix: { feature: pctOf(mixMs.feature), bug: pctOf(mixMs.bug), try: pctOf(mixMs.try), chore: pctOf(mixMs.chore) },
    owned, people, table, look: look.slice(0, 5),
  };
}

export function itemView(project: string, itemId: string, viewer: { member: string; role?: string }) {
  const at = now();
  const S = load(project, at);
  const it = S.byId.get(itemId);
  if (!it) return null;
  const v: Viewer = { member: viewer.member, lead: viewer.role === "owner" || viewer.role === "admin" || isLead(S, viewer.member) };
  const rel = it.parent_id ? S.releases.get(it.parent_id) : undefined;
  const thread = db.prepare("SELECT * FROM posts WHERE item_id = ? ORDER BY created_at ASC LIMIT 300").all(it.id) as PostRow[];
  const fileRows = db
    .prepare("SELECT path, MAX(at) AS t FROM session_marks WHERE item_id = ? AND path IS NOT NULL GROUP BY path ORDER BY t DESC LIMIT 50")
    .all(it.id) as { path: string }[];
  const files = fileRows.map((f) => f.path);

  // Other open items working in the same folders.
  const nearby: { text: string; meta: string }[] = [];
  if (files.length) {
    const myDirs = new Set(files.map(dirOf).filter(Boolean));
    const mine = new Set(files);
    const others = db
      .prepare("SELECT DISTINCT item_id, path FROM session_marks WHERE project = ? AND item_id IS NOT NULL AND item_id != ? AND path IS NOT NULL AND at >= ?")
      .all(project, it.id, at - 14 * DAY) as { item_id: string; path: string }[];
    const byItem = new Map<string, string[]>();
    for (const o of others) (byItem.get(o.item_id) ?? byItem.set(o.item_id, []).get(o.item_id)!).push(o.path);
    for (const [id, paths] of byItem) {
      const other = S.byId.get(id);
      if (!other || itemStatus(other) === "done") continue;
      const shared = paths.filter((p) => mine.has(p)).length;
      const dir = paths.map(dirOf).find((d) => d && myDirs.has(d));
      if (!shared && !dir) continue;
      nearby.push({
        text: `${other.title} (${who(S, other.member ?? "").displayName}) works in the same folder, ${dir ?? dirOf(paths[0]!)}/.`,
        meta: shared ? `${shared} shared file${shared === 1 ? "" : "s"}` : "no shared files yet",
      });
      if (nearby.length >= 4) break;
    }
  }

  return {
    item: {
      id: it.id, title: it.title, kind: itemKind(it), status: itemStatus(it), owner: who(S, it.member ?? ""),
      release: rel ? { id: rel.id, title: rel.title, dueAt: rel.due_at } : null,
      branch: S.hide ? null : it.branch, summary: it.summary, createdAt: it.created_at,
      steps: (S.steps.get(it.id) ?? []).map((s) => ({
        id: s.id, text: s.text, done: !!s.done, doneBy: s.done && s.done_by ? who(S, s.done_by) : null, doneSource: s.done ? s.done_source : null, doneAt: s.done ? s.done_at : null,
      })),
    },
    agents: S.sessions
      .filter((s) => s.item_id === it.id && (effectiveState(s, at) !== "ended" || at - s.last_seen < DAY))
      .filter((s, i, all) => all.findIndex((x) => laneKey(x) === laneKey(s)) === i) // one per agent per worktree (newest first)
      .map((s) => ({ sessionId: s.id, source: s.source, who: who(S, s.member), branch: branchOf(S, s), worktree: s.worktree, state: effectiveState(s, at), stateSince: effectiveSince(s, at), lastLine: s.last_line })),
    thread: thread.map((p) => postOut(S, p)),
    open: S.open.filter((p) => p.item_id === it.id && addressed(p, v) && p.author !== v.member).map((p) => postOut(S, p)),
    files,
    nearby,
    proposals: listGoalProposals(project)
      .filter((p) => p.goalId === it.id)
      .map((p) => ({
        id: p.id,
        text: p.kind === "check_item" ? `Tick "${p.itemText ?? ""}"` : p.kind === "add_item" ? `Add step "${p.text ?? ""}"` : "Mark blocked",
        reason: p.reason,
      })),
  };
}

export function personView(project: string, member: string, viewer: { member: string; role?: string }, opts: ViewOpts) {
  const at = now();
  const S = load(project, at);
  if (!S.names.has(member) && !S.items.some((i) => i.member === member)) return null;
  const v: Viewer = { member: viewer.member, lead: viewer.role === "owner" || viewer.role === "admin" || isLead(S, viewer.member) };
  const from = dayStart(at, opts.tz) - 6 * DAY;
  const segs = sessionSegments(project, from, at, { member }, at);
  const sumMs = (pred: (g: Segment) => boolean) => segs.filter(pred).reduce((n, g) => n + g.to - g.from, 0);
  const mineOpen = openItems(S).filter((i) => i.member === member);
  const finished = S.items.filter((i) => i.member === member && i.done_at && i.done_at >= from);
  const stepsTicked = (db
    .prepare("SELECT COUNT(*) AS n FROM goal_items i JOIN goals g ON g.id = i.goal_id WHERE g.project = ? AND i.done = 1 AND i.done_by = ? AND i.done_at >= ?")
    .get(project, member, from) as { n: number }).n;
  const help = helpCounts(project, member, from);
  const sessions = S.sessions
    .filter((s) => s.member === member && effectiveState(s, at) !== "ended" && at - s.last_seen < DAY)
    .filter((s, i, all) => all.findIndex((x) => laneKey(x) === laneKey(s)) === i); // one per agent per worktree
  return {
    who: who(S, member),
    owns: ownsText(mineOpen),
    agentsNow: sessions.filter((s) => ["working", "waiting", "blocked"].includes(effectiveState(s, at))).length,
    stats: {
      done: finished.length, stepsTicked,
      activeHours: round1(sumMs((g) => g.state === "working")), blockedHours: round1(sumMs((g) => g.state !== "working")),
      helped: help.helped, asked: help.asked, askMedianMin: help.askMedianMin,
    },
    owned: mineOpen.map((i) => lane(S, i, v)),
    finished: finished.map((i) => ({ id: i.id, title: i.title, kind: itemKind(i) })),
    week: dayBuckets(S, segs, from, 7, opts.tz),
    agents: sessions.map((s) => {
      const it = s.item_id ? S.byId.get(s.item_id) : undefined;
      const posts = db.prepare("SELECT text FROM posts WHERE session_id = ? ORDER BY created_at DESC LIMIT 2").all(s.id) as { text: string }[];
      return {
        sessionId: s.id, source: s.source, item: it ? { id: it.id, title: it.title } : null, branch: branchOf(S, s), state: effectiveState(s, at),
        lines: [...posts.reverse().map((p) => clip(p.text, 140)), ...(s.last_line ? [s.last_line] : [])],
      };
    }),
    traits: traitsOf(project, member),
  };
}

// ── Agent API read model ──────────────────────────────────────
export function agentContext(project: string, member: string, session: SessionRow | null) {
  const at = now();
  const S = load(project, at);
  const v: Viewer = { member, lead: isLead(S, member) };
  const itemOut = (i: ItemRow) => ({
    id: i.id, title: i.title, kind: itemKind(i), status: itemStatus(i),
    steps: (S.steps.get(i.id) ?? []).map((s) => ({ id: s.id, text: s.text, done: !!s.done })),
  });
  const cur = session?.item_id ? S.byId.get(session.item_id) : undefined;
  const rel = currentRelease(S);
  return {
    me: who(S, member),
    myItems: openItems(S).filter((i) => i.member === member).map(itemOut),
    current: cur ? itemOut(cur) : null,
    openForMe: asksFor(S, v).map((p) => postOut(S, p)),
    teammates: teamMembers(S, at - 7 * DAY)
      .filter((m) => m !== member)
      .map((m) => ({
        who: who(S, m),
        items: openItems(S).filter((i) => i.member === m).map((i) => ({ id: i.id, title: i.title, kind: itemKind(i), status: itemStatus(i) })),
        sessions: S.sessions
          .filter((s) => s.member === m && effectiveState(s, at) !== "ended" && at - s.last_seen < 12 * HOUR)
          .map((s) => ({ source: s.source, branch: branchOf(S, s), state: effectiveState(s, at), lastLine: s.last_line })),
      })),
    release: rel ? { id: rel.id, title: rel.title, dueAt: rel.due_at } : null,
  };
}

// ── Pack lines: teammate context delivered once per session ────
/**
 * Lines for the member pack: asks addressed to me, asks I let my agent answer,
 * answers to my questions, handovers to me, notes on my items, and my current item.
 * Keys are stable per post (and per item state), so the hook's seen-keys deliver
 * each once per session. Keys start with "w" (never "q": those are prompt-specific).
 */
export function workPackLines(project: string, me: string, sessionId?: string, at = now()): { k: string; text: string }[] {
  const S = load(project, at);
  const v: Viewer = { member: me, lead: isLead(S, me) };
  const out: { k: string; text: string }[] = [];
  const about = (p: PostRow) => (p.item_id && S.byId.get(p.item_id) ? ` (on "${S.byId.get(p.item_id)!.title}")` : "");

  for (const p of asksFor(S, v)) {
    const by = byLabel(S, p.author, p.source);
    if (p.delegate) {
      out.push({ k: `wd:${p.id}`, text: `${by} asked${about(p)}: "${clip(p.text, 140)}" — answer it now with the reins_answer tool (questionId ${p.id}) in 1–3 sentences, from what this repo and your session show; say you don't know rather than guess. Then carry on with your user's request.` });
    } else {
      out.push({ k: `wq:${p.id}`, text: `${by} asked your user${p.to_member ? "" : " (as a lead)"}${about(p)}: "${clip(p.text, 140)}" — mention it to your user; don't answer it yourself.` });
    }
  }
  const recent = db
    .prepare(
      `SELECT a.*, q.text AS q_text FROM posts a JOIN posts q ON q.id = a.reply_to
        WHERE a.project = ? AND a.kind = 'answer' AND q.author = ? AND a.author != ? AND a.created_at >= ? ORDER BY a.created_at ASC`
    )
    .all(project, me, me, at - DAY) as (PostRow & { q_text: string })[];
  for (const a of recent) {
    out.push({ k: `wa:${a.id}`, text: `${byLabel(S, a.author, a.source)} answered your question "${clip(a.q_text, 60)}": ${clip(a.text, 160)}` });
  }
  const notes = db
    .prepare(
      `SELECT * FROM posts WHERE project = ? AND author != ? AND created_at >= ? AND (
          (kind = 'handover' AND to_member = ?)
       OR (kind IN ('note','review','update','finding') AND item_id IN (SELECT id FROM goals WHERE project = ? AND scope = 'individual' AND member = ?))
       OR (kind = 'note' AND to_member = ?)
       ) ORDER BY created_at ASC`
    )
    .all(project, me, at - DAY, me, project, me, me) as PostRow[];
  for (const p of notes) {
    const by = byLabel(S, p.author, p.source);
    if (p.kind === "handover") {
      const title = p.item_id ? S.byId.get(p.item_id)?.title : null;
      out.push({ k: `wh:${p.id}`, text: `${by} handed you${title ? ` "${title}"` : " an item"}: ${clip(p.text, 160)}` });
    } else {
      out.push({ k: `wn:${p.id}`, text: `${by} wrote${about(p)}${p.kind === "note" ? "" : ` (${p.kind})`}: ${clip(p.text, 160)}` });
    }
  }
  const sess = sessionId ? S.sessions.find((s) => s.id === sessionId || s.id === `${project}/${sessionId}`) : undefined;
  const cur = sess?.item_id ? S.byId.get(sess.item_id) : undefined;
  if (cur && itemStatus(cur) !== "done") {
    const st = S.steps.get(cur.id) ?? [];
    const open = st.filter((s) => !s.done);
    const sig = `${cur.id}:${st.length}:${open.length}`;
    out.push({
      k: `wc:${createHash("sha1").update(sig).digest("hex").slice(0, 10)}`,
      text: `Your current item: "${cur.title}" (${itemKind(cur)}, ${st.length - open.length}/${st.length} steps)${open.length ? `. Next: ${open.slice(0, 3).map((s) => clip(s.text, 50)).join("; ")}` : ""}. Tick steps with reins_step_done (ids via reins_my_items).`,
    });
  }
  return out;
}
