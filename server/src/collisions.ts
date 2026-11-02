/**
 * Deterministic coordination signals — no LLM involved.
 *
 * Who is working on what right now comes from three sources, strongest first:
 * real file touches (the hook records every edit), git state (dirty files and
 * branch, reported with each event), and the distilled working_on list. From
 * them we compute overlaps between PRESENT teammates, keep one collision handoff
 * open per pair while an overlap lasts, and auto-close coordination handoffs once
 * the reason for them is gone (overlap ended, blocking item resolved, work merged).
 */
import { z } from "zod";
import {
  listMembers,
  getRollup,
  resolveMember,
  createHandoff,
  autoCloseHandoff,
  openHandoffsOfKind,
  getPendingItem,
  recentTouches,
  clearTouches,
  setMemberGit,
  activeAssignments,
  projectHidesBranches,
} from "./db.js";
import { liveness, TOUCH_WINDOW_MS } from "./liveness.js";
import { bus } from "./bus.js";

/** Normalize a working_on entry to a comparable file path, or null if it isn't
 *  path-like (free-text areas such as "auth refactor" are left to the LLM). */
export function normPath(s: unknown): string | null {
  const p = String(s ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").toLowerCase();
  if (!p || /\s/.test(p) || !/[./]/.test(p)) return null;
  return p;
}

export const samePath = (a: string, b: string) => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);

/**
 * Deterministic file collisions: path-like working_on entries shared by two or
 * more teammates. Equal paths overlap, and so does a path that is a
 * segment-suffix of another ("src/db.ts" vs "server/src/db.ts"), since agents
 * report paths relative to different roots. Returns one entry per area with the
 * member ids involved (≥2), the longer spelling as the area.
 */
export function fileOverlaps(members: { member: string; working_on?: string }[]): { area: string; members: string[] }[] {
  const entries: { member: string; path: string }[] = [];
  for (const m of members) {
    let list: unknown = [];
    try { list = JSON.parse(m.working_on || "[]"); } catch { /* bad json → none */ }
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const path = normPath(raw);
      if (path) entries.push({ member: m.member, path });
    }
  }
  const areas: { area: string; members: Set<string> }[] = [];
  for (const e of entries) {
    const hit = areas.find((x) => samePath(x.area, e.path));
    if (hit) {
      hit.members.add(e.member);
      if (e.path.length > hit.area.length) hit.area = e.path;
    } else {
      areas.push({ area: e.path, members: new Set([e.member]) });
    }
  }
  // Sorted so the prompt and handoff direction don't depend on member row order.
  return areas.filter((a) => a.members.size > 1).map((a) => ({ area: a.area, members: [...a.members].sort() }));
}

export function parseList(s: unknown): string[] {
  try {
    const v = JSON.parse(String(s ?? "[]"));
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** What each PRESENT member is on right now: distilled working_on, files they
 *  really touched within the window, and their git dirty files. */
export function presentWork(project: string, at = Date.now()) {
  const touches = recentTouches(project, at - TOUCH_WINDOW_MS);
  return listMembers(project)
    .filter((m) => liveness(m.last_seen, at) !== "away")
    .map((m) => ({
      row: m,
      member: m.member as string,
      workingOn: parseList(m.working_on),
      touched: touches.filter((t) => t.member === m.member),
      dirty: parseList(m.dirty_files),
    }));
}

/** A branch that counts as "the same work": not the default branch, not detached. */
function workBranch(row: any): string | null {
  const b = row.branch as string | null;
  if (!b || b === "HEAD") return null;
  if (row.default_branch ? b === row.default_branch : b === "main" || b === "master") return null;
  return b;
}

export interface Overlap { area: string; members: string[]; kind: "file" | "branch" }

/** Live overlaps between present teammates: shared files (touches + dirty + working_on)
 *  and two or more people on the same non-default branch. */
export function computeOverlaps(project: string, at = Date.now()): Overlap[] {
  const work = presentWork(project, at);
  const out: Overlap[] = fileOverlaps(
    work.map((w) => ({
      member: w.member,
      working_on: JSON.stringify([...w.workingOn, ...w.touched.map((t) => t.path), ...w.dirty]),
    }))
  ).map((o) => ({ ...o, kind: "file" as const }));
  const hide = projectHidesBranches(project);
  const byBranch = new Map<string, string[]>();
  for (const w of work) {
    const b = workBranch(w.row);
    if (b) (byBranch.get(b) ?? byBranch.set(b, []).get(b)!).push(w.member);
  }
  for (const [b, ms] of byBranch) {
    if (ms.length > 1) out.push({ area: hide ? "the same branch" : `branch ${b}`, members: ms.sort(), kind: "branch" });
  }
  return out;
}

const pairKey = (to: string, from: string | null | undefined) => `${to}\u0000${from ?? ""}`;

/**
 * The deterministic check, run after every touch, git update, rollup, and on a
 * periodic sweep: open a collision handoff for each live overlap pair, and
 * auto-close coordination handoffs whose reason is gone. A collision stays open
 * while the pair still overlaps or the latest rollup reported them colliding in
 * its own words (an area the computation can't see). `merged` attributes closes
 * involving that member to their merge instead of a generic "overlap ended".
 */
export function reconcileCollisions(
  project: string,
  opts: { eventId?: string | null; extraPairs?: [string, string][]; merged?: { member: string; reason: string } } = {}
): { created: number; closed: number } {
  const members = listMembers(project);
  const nameOf = new Map(members.map((m: any) => [m.member, m.display_name || m.member]));
  const live = new Set<string>();
  let created = 0;
  let closed = 0;
  for (const o of computeOverlaps(project)) {
    for (const to of o.members) {
      for (const from of o.members) {
        if (from === to) continue;
        live.add(pairKey(to, from));
        const text =
          o.kind === "file"
            ? `You and ${nameOf.get(from)} are both working on ${o.area} — coordinate before editing it.`
            : // The branch name stays out of the stored text (privacy can be turned on later).
              `You and ${nameOf.get(from)} are both on the same work branch — agree who changes what before either of you pushes.`;
        if (createHandoff({ project, toMember: to, fromMember: from, kind: "collision", text, area: o.area })) created++;
      }
    }
  }

  const reported = new Set<string>();
  for (const [a, b] of opts.extraPairs ?? []) { reported.add(pairKey(a, b)); reported.add(pairKey(b, a)); }
  let rollupCollisions: any[] = [];
  try { rollupCollisions = JSON.parse(getRollup(project)?.collisions || "[]"); } catch { /* none */ }
  for (const c of rollupCollisions) {
    if (c?.computed || !Array.isArray(c?.members)) continue;
    const ids = c.members.map((n: string) => resolveMember(project, n)).filter(Boolean) as string[];
    for (const a of ids) for (const b of ids) if (a !== b) reported.add(pairKey(a, b));
  }

  for (const h of openHandoffsOfKind(project, ["collision"])) {
    const k = pairKey(h.to_member, h.from_member);
    if (live.has(k) || reported.has(k)) continue;
    const m = opts.merged && (h.to_member === opts.merged.member || h.from_member === opts.merged.member) ? opts.merged : null;
    const ok = m
      ? autoCloseHandoff(project, h.id, "work_merged", m.reason, opts.eventId)
      : autoCloseHandoff(
          project, h.id, "overlap_ended",
          h.area && !/^(branch |the same branch)/.test(h.area)
            ? `overlap ended — ${h.area} is no longer shared`
            : "overlap ended — no shared files or branch now",
          opts.eventId
        );
    if (ok) closed++;
  }

  // Blockers that waited on a pending item that has since been resolved.
  for (const h of openHandoffsOfKind(project, ["blocker"])) {
    if (!h.ref) continue;
    const p = getPendingItem(project, h.ref);
    if (p?.status === "done" && autoCloseHandoff(project, h.id, "blocker_resolved", `blocking item resolved: ${p.text.slice(0, 120)}`, opts.eventId)) closed++;
  }

  if (created || closed) bus.emitChange({ type: "handoff.changed", project });
  return { created, closed };
}

// ── Git state + merge detection ───────────────────────────────
const GitMeta = z.object({
  branch: z.string().max(200).optional(),
  head: z.string().max(64).optional(),
  defaultBranch: z.string().max(200).optional(),
  dirty: z.number().int().min(0).max(1_000_000).optional(),
  dirtyFiles: z.array(z.string().max(500)).max(50).optional(),
  merged: z.object({ branch: z.string().max(200), head: z.string().max(64) }).optional(),
});

// An agent's turn summary reporting a merged PR ("merged PR #42", "the pull request
// was merged"). Hedged phrasing ("once it's merged", "not merged yet") doesn't count.
const MERGED_PR = /\b(?:merged|landed)\b[^\n.]{0,60}\b(?:PR|pull request)\b|\b(?:PR|pull request)\b[^\n.]{0,60}\b(?:was|is|got|been|now)\s+(?:merged|landed)\b/i;
const HEDGED = /\b(?:not|n't|once|until|before|after|when|if|unless|ready to|waiting|awaiting|to be|should be|will be|can be)\b[^\n.]{0,20}\b(?:merged|landed)\b/i;

export function reportsMergedPr(text: string): boolean {
  const t = (text || "").slice(0, 4000);
  return MERGED_PR.test(t) && !HEDGED.test(t);
}

/**
 * Apply the git block of an event's meta (branch, head, dirty files) to the
 * member, and settle their coordination when their work landed. Two signals,
 * either sufficient:
 *  - git: the hook saw the member leave a non-default branch for the default
 *    branch AND `git merge-base --is-ancestor <old head> HEAD` held locally, i.e.
 *    the default branch now contains their last commit (merge or fast-forward);
 *  - text: their agent's turn summary reports a merged PR.
 * Returns whether anything was applied.
 */
export function applyGitMeta(
  project: string,
  member: string,
  meta: unknown,
  opts: { eventId?: string | null; kind?: string; text?: string } = {}
): boolean {
  const raw = (meta && typeof meta === "object" ? (meta as any).git : undefined) ?? undefined;
  const parsed = raw ? GitMeta.safeParse(raw) : null;
  const git = parsed?.success ? parsed.data : null;
  if (git) setMemberGit(project, member, git);

  let merged: { branch?: string; via: "git" | "summary" } | null = null;
  if (git?.merged) merged = { branch: git.merged.branch, via: "git" };
  else if (opts.kind === "summary" && opts.text && reportsMergedPr(opts.text)) {
    const row = listMembers(project).find((m: any) => m.member === member);
    merged = { branch: row ? workBranch(row) ?? undefined : undefined, via: "summary" };
  }
  if (merged) {
    onWorkMerged(project, member, { ...merged, eventId: opts.eventId });
    return true;
  }
  if (git) reconcileCollisions(project, { eventId: opts.eventId });
  return !!git;
}

/** A member's work landed: their touches no longer overlap anyone, blockers they
 *  owned are settled, and collisions involving them close as merged. */
export function onWorkMerged(
  project: string,
  member: string,
  info: { branch?: string; via: "git" | "summary"; eventId?: string | null }
): number {
  const row = listMembers(project).find((m: any) => m.member === member);
  const name = row?.display_name || member;
  // Stored reasons never name the branch, so turning branch privacy on later
  // doesn't leave names behind in handoff history.
  const reason = info.via === "git" ? `${name}'s work merged into the default branch` : `${name}'s agent reported the PR merged`;
  clearTouches(project, member);
  let closed = 0;
  for (const h of openHandoffsOfKind(project, ["blocker"])) {
    if (h.to_member === member && autoCloseHandoff(project, h.id, "work_merged", reason, info.eventId)) closed++;
  }
  if (closed) bus.emitChange({ type: "handoff.changed", project });
  closed += reconcileCollisions(project, { eventId: info.eventId, merged: { member, reason } }).closed;
  bus.emitChange({ type: "member.updated", project, member });
  return closed;
}

// ── Pre-edit check ────────────────────────────────────────────
/** Whether an assigned area covers a path: the same file, or a directory holding it. */
export function areaCovers(area: string, path: string): boolean {
  const a = normPath(area);
  if (!a) return false;
  return samePath(a, path) || path.startsWith(`${a}/`) || path.includes(`/${a}/`);
}

function ago(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

/**
 * Before `member` edits `path`: is a present teammate on the same file (a recent
 * touch or an uncommitted change), or does someone else hold an assignment that
 * covers it? Returns the warnings and the one-paragraph text the hook hands the
 * model. Never a block — the edit always goes ahead.
 */
export function editWarnings(project: string, member: string, path: string, at = Date.now()) {
  const p = normPath(path);
  const warnings: { kind: "touch" | "dirty" | "assignment"; member: string; name: string; text: string }[] = [];
  if (!p) return { warnings, text: "" };
  const members = listMembers(project);
  const byId = new Map(members.map((m: any) => [m.member, m]));
  const nameOf = (id: string) => byId.get(id)?.display_name || id;
  const present = (id: string) => liveness(byId.get(id)?.last_seen, at) !== "away";
  const headline = (id: string) => (byId.get(id)?.headline ? ` (now: ${String(byId.get(id).headline).slice(0, 90)})` : "");

  const seen = new Set<string>();
  for (const t of recentTouches(project, at - TOUCH_WINDOW_MS)) {
    if (t.member === member || seen.has(t.member) || !present(t.member)) continue;
    const tp = normPath(t.path);
    if (!tp || !samePath(tp, p)) continue;
    seen.add(t.member);
    warnings.push({ kind: "touch", member: t.member, name: nameOf(t.member), text: `${nameOf(t.member)} edited ${t.path} ${ago(at - t.created_at)}${headline(t.member)}` });
  }
  for (const m of members) {
    if (m.member === member || seen.has(m.member) || !present(m.member)) continue;
    const hit = parseList(m.dirty_files).find((f) => { const fp = normPath(f); return !!fp && samePath(fp, p); });
    if (!hit) continue;
    seen.add(m.member);
    warnings.push({ kind: "dirty", member: m.member, name: nameOf(m.member), text: `${nameOf(m.member)} has uncommitted changes to ${hit}${headline(m.member)}` });
  }
  for (const a of activeAssignments(project)) {
    if (a.member === member || !areaCovers(a.area, p)) continue;
    const by = a.created_by ? ` (${a.created_by})` : "";
    warnings.push({ kind: "assignment", member: a.member, name: nameOf(a.member), text: `${a.area} is assigned to ${nameOf(a.member)} by the lead${by}` });
  }
  if (!warnings.length) return { warnings, text: "" };
  const text =
    `Reins heads-up before you edit ${path}: ${warnings.map((w) => w.text).join("; ")}. ` +
    `This is advisory and the edit is not blocked — if your change overlaps theirs, tell your user and coordinate with ${[...new Set(warnings.map((w) => w.name))].join(" / ")} first.`;
  return { warnings, text };
}
