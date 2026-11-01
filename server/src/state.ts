import {
  getProject,
  listProjects,
  listMembers,
  getMember,
  recentTimeline,
  listPending,
  getRollup,
  incomingHandoffs,
  resolvedHandoffs,
  listHandoffs,
  buildProfileView,
  recentAutoClosed,
  recentTouches,
  activeDirectives,
  activeAssignments,
  projectHidesBranches,
  traitsShared,
  resolveMember,
} from "./db.js";
import { STALE_MS, TOUCH_WINDOW_MS } from "./liveness.js";
import { computeOverlaps } from "./collisions.js";

function handoffView(h: any, hideBranches = false) {
  return {
    id: h.id,
    to: h.to_member,
    from: h.from_member,
    kind: h.kind,
    text: h.text,
    status: h.status,
    createdAt: h.created_at,
    updatedAt: h.updated_at,
    area: hideBranches && /^branch /.test(h.area ?? "") ? "the same branch" : h.area ?? null,
    conventions: parseArr(h.conventions),
    // Set when Reins closed it on its own: why, and the event that triggered it.
    autoClosed: h.auto_code ? { code: h.auto_code, reason: h.auto_reason || "", event: h.auto_event ?? null } : null,
  };
}

const directiveView = (d: any) => ({
  id: d.id, text: d.text, targets: parseArr(d.targets), by: d.created_by, createdAt: d.created_at, expiresAt: d.expires_at,
});
const assignmentView = (a: any) => ({
  id: a.id, member: a.member, area: a.area, note: a.note, by: a.created_by, createdAt: a.created_at,
});

// Auto-closed handoffs stay visible (with reopen) on the card for this long.
const AUTO_CLOSED_VISIBLE_MS = 24 * 60 * 60 * 1000;

function parseArr(s: unknown): any[] {
  try {
    const v = JSON.parse(String(s ?? "[]"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function memberView(project: string, m: any, ctx?: { hideBranches: boolean; touches: { member: string; path: string; created_at: number }[] }) {
  const live = Date.now() - (m.last_seen ?? 0) < STALE_MS;
  const hide = ctx ? ctx.hideBranches : projectHidesBranches(project);
  const touches = (ctx?.touches ?? recentTouches(project, Date.now() - TOUCH_WINDOW_MS))
    .filter((t) => t.member === m.member)
    .slice(0, 8)
    .map((t) => ({ path: t.path, at: t.created_at }));
  const open = incomingHandoffs(project, m.member);
  return {
    member: m.member,
    displayName: m.display_name || m.member,
    headline: m.headline || "",
    goal: m.goal || "",
    status: m.status || "idle",
    // What the UI should show: a stale member is no longer "active"/"blocked".
    displayStatus: live ? m.status || "idle" : "idle",
    live,
    workingOn: parseArr(m.working_on),
    lastSeen: m.last_seen,
    updatedAt: m.updated_at,
    // Files they really edited recently (the hook), next to the inferred workingOn.
    touches,
    // Branch names are withheld entirely when the workspace hides them.
    git: m.git_at
      ? { branch: hide ? null : m.branch ?? null, head: hide ? null : m.head ?? null, dirty: m.dirty_count ?? 0, at: m.git_at }
      : null,
    handoffs: open.map((h) => handoffView(h, hide)),
    // Skip one superseded by a newer open handoff for the same pair and kind.
    autoClosed: recentAutoClosed(project, m.member, Date.now() - AUTO_CLOSED_VISIBLE_MS)
      .filter((h) => !open.some((o) => o.kind === h.kind && o.from_member === h.from_member))
      .map((h) => handoffView(h, hide)),
    timeline: recentTimeline(project, m.member, 8).map((t) => ({
      kind: t.kind,
      summary: t.summary,
      at: t.created_at,
    })),
  };
}

/**
 * Full per-member detail: long timeline, their pending, and the learned taste
 * profile.
 *
 * Raw prompt text is deliberately NOT returned. It still lives in the `events`
 * table for the distillation pipeline to read, but surfacing the raw
 * back-and-forth a teammate had with their agent feels exposing even with
 * consent. The UI gets only the distilled timeline and the taste profile — the
 * abstractions that carry the meaning without the exposure.
 */
export function memberDetail(project: string, member: string) {
  const m = getMember(project, member);
  if (!m) return null;
  const base = memberView(project, m);
  const timeline = recentTimeline(project, member, 40).map((t) => ({
    kind: t.kind,
    summary: t.summary,
    at: t.created_at,
  }));
  const pending = listPending(project)
    .filter((p) => p.member === member && p.status !== "done")
    .map((p) => ({ id: p.id, text: p.text, status: p.status, claimedBy: p.claimed_by, createdAt: p.created_at }));
  const profile = buildProfileView(project, member);
  const hide = projectHidesBranches(project);
  const resolvedHandoffsList = resolvedHandoffs(project, member).map((h) => handoffView(h, hide));
  // Directives aimed at them (or the whole team) and what the lead assigned them.
  const directives = activeDirectives(project)
    .map(directiveView)
    .filter((d) => d.targets.length === 0 || d.targets.includes(member));
  const assignments = activeAssignments(project).filter((a) => a.member === member).map(assignmentView);
  return {
    ...base, projectId: project, timeline, pending, profile, resolvedHandoffs: resolvedHandoffsList,
    directives, assignments, sharesTraits: traitsShared(project, member),
  };
}

export function projectSnapshot(projectId: string) {
  const proj = getProject(projectId);
  if (!proj) return null;
  const ctx = { hideBranches: projectHidesBranches(projectId), touches: recentTouches(projectId, Date.now() - TOUCH_WINDOW_MS) };
  const rows = listMembers(projectId);
  const members = rows.map((m) => memberView(projectId, m, ctx));
  const nameOf = new Map(rows.map((m: any) => [m.member, m.display_name || m.member]));
  const rollup = getRollup(projectId);
  // Collisions are live: the rollup's computed ones are replaced by the overlaps
  // as they stand right now (real edits, git, working_on), so a new collision shows
  // the moment it happens and an ended one drops off without waiting for a rollup.
  const overlaps = computeOverlaps(projectId);
  const live = overlaps.map((o) => ({
    area: o.area,
    members: o.members.map((id) => nameOf.get(id) || id),
    note: o.kind === "file" ? "both are working on this file" : "both are on this branch",
    computed: true,
  }));
  // A stored model collision between the same people as a live overlap is the same
  // collision (rollups saved before the `computed` tag existed carry no tag at all),
  // so show the live one only.
  const pairKey = (ids: string[]) => [...ids].sort().join("\u0000");
  const liveKeys = new Set(overlaps.map((o) => pairKey(o.members)));
  const storedCollisions = rollup
    ? parseArr(rollup.collisions).filter(
        (c: any) =>
          !c?.computed &&
          !liveKeys.has(pairKey((c?.members ?? []).map((n: string) => resolveMember(projectId, n) ?? n)))
      )
    : [];
  return {
    id: proj.id,
    name: proj.name,
    goal: proj.goal,
    goalSetBy: proj.goal_set_by,
    updatedAt: proj.updated_at,
    members,
    handoffs: listHandoffs(projectId).map((h) => handoffView(h, ctx.hideBranches)),
    pending: listPending(projectId).map((p) => ({
      id: p.id,
      member: p.member,
      text: p.text,
      status: p.status,
      claimedBy: p.claimed_by,
      createdAt: p.created_at,
    })),
    rollup: rollup
      ? {
          summary: rollup.summary,
          alignment: rollup.alignment,
          collisions: [...storedCollisions, ...live],
          risks: JSON.parse(rollup.risks || "[]"),
          updatedAt: rollup.updated_at,
        }
      : null,
    // Overlaps also show before the first rollup exists.
    collisions: live,
    directives: activeDirectives(projectId).map(directiveView),
    assignments: activeAssignments(projectId).map(assignmentView),
    hideBranches: ctx.hideBranches,
  };
}

export function projectsList(workspaceId?: string) {
  return listProjects(workspaceId).map((p) => {
    const members = listMembers(p.id);
    const active = members.filter((m) => m.status === "active").length;
    return {
      id: p.id,
      name: p.name,
      goal: p.goal,
      members: members.length,
      active,
      updatedAt: p.updated_at,
    };
  });
}
