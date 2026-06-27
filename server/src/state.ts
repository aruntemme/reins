import {
  getProject,
  listProjects,
  listMembers,
  getMember,
  recentTimeline,
  listPending,
  getRollup,
  incomingHandoffs,
  listHandoffs,
  buildProfileView,
} from "./db.js";
import { storageExplorerUrl } from "./llm/og-storage.js";

function handoffView(h: any) {
  return {
    id: h.id,
    to: h.to_member,
    from: h.from_member,
    kind: h.kind,
    text: h.text,
    status: h.status,
    createdAt: h.created_at,
  };
}

// A member whose last signal is older than this reads as no longer live; an
// "active" headline from hours ago should not be presented as the present.
const STALE_MS = 20 * 60 * 1000;

function parseArr(s: unknown): string[] {
  try {
    const v = JSON.parse(String(s ?? "[]"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function memberView(project: string, m: any) {
  const live = Date.now() - (m.last_seen ?? 0) < STALE_MS;
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
    handoffs: incomingHandoffs(project, m.member).map(handoffView),
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
  return { ...base, projectId: project, timeline, pending, profile };
}

export function projectSnapshot(projectId: string) {
  const proj = getProject(projectId);
  if (!proj) return null;
  const members = listMembers(projectId).map((m) => memberView(projectId, m));
  const rollup = getRollup(projectId);
  return {
    id: proj.id,
    name: proj.name,
    goal: proj.goal,
    goalSetBy: proj.goal_set_by,
    updatedAt: proj.updated_at,
    members,
    handoffs: listHandoffs(projectId).map(handoffView),
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
          collisions: JSON.parse(rollup.collisions || "[]"),
          risks: JSON.parse(rollup.risks || "[]"),
          updatedAt: rollup.updated_at,
          // 0G Storage provenance for this snapshot (empty until anchored).
          provenance: rollup.root_hash
            ? {
                rootHash: rollup.root_hash,
                txHash: rollup.tx_hash,
                anchoredAt: rollup.anchored_at,
                storageUrl: storageExplorerUrl(rollup.root_hash),
              }
            : null,
        }
      : null,
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
