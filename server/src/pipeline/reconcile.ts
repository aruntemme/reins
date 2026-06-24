import {
  db,
  addTimeline,
  findOpenPending,
  upsertPending,
  setPendingStatus,
  now,
} from "../db.js";
import { jsonComplete } from "../llm/client.js";
import { bus } from "../bus.js";
import { ReconcileSchema } from "./schemas.js";
import type { Extract } from "./schemas.js";

export interface Ops {
  headline?: string | null;
  goal?: string | null;
  status?: "active" | "blocked" | "idle" | null;
  working_on?: string[] | null;
  timeline_add?: { kind: "did" | "decided" | "blocked" | "started"; summary: string }[];
  pending_add?: string[];
  pending_resolve?: string[];
}

/**
 * Apply a reconcile op-set (the "tool dispatch", in code) to a member's living
 * context and emit the right change events. Shared by the staged reconcile()
 * and the combined single-call distiller.
 */
export function applyOps(project: string, member: string, ops: Ops): void {
  const openPending = findOpenPending(project, member);

  const memberPatch: Record<string, unknown> = {};
  if (ops.headline != null) memberPatch.headline = ops.headline.slice(0, 240);
  if (ops.goal != null) memberPatch.goal = ops.goal.slice(0, 300);
  if (ops.status != null) memberPatch.status = ops.status;
  if (ops.working_on != null) memberPatch.working_on = JSON.stringify(ops.working_on.slice(0, 12));

  let memberTouched = false;
  const cols = Object.keys(memberPatch);
  if (cols.length) {
    db.prepare(
      `UPDATE members SET ${cols.map((c) => `${c} = @${c}`).join(", ")}, updated_at = @ts
       WHERE project = @project AND member = @member`
    ).run({ ...memberPatch, ts: now(), project, member });
    memberTouched = true;
  }

  let timelineTouched = false;
  for (const t of ops.timeline_add ?? []) {
    if (!t?.summary?.trim()) continue;
    addTimeline(project, member, t.kind, t.summary.slice(0, 280));
    timelineTouched = true;
  }

  let pendingTouched = false;
  const existingTexts = new Set(openPending.map((p) => p.text.trim().toLowerCase()));
  for (const text of ops.pending_add ?? []) {
    const v = text?.trim();
    if (!v || existingTexts.has(v.toLowerCase())) continue;
    upsertPending(project, member, v.slice(0, 280));
    pendingTouched = true;
  }
  const validIds = new Set(openPending.map((p) => p.id));
  for (const id of ops.pending_resolve ?? []) {
    if (!validIds.has(id)) continue;
    setPendingStatus(id, "done");
    pendingTouched = true;
  }

  if (memberTouched) bus.emitChange({ type: "member.updated", project, member });
  if (timelineTouched) bus.emitChange({ type: "timeline.added", project, member });
  if (pendingTouched) bus.emitChange({ type: "pending.changed", project });
}

const SYSTEM = `You are the reconciler of Reins — you maintain ONE teammate's LIVING CONTEXT on a
shared team board. Given their CURRENT state and freshly EXTRACTED facts from their latest
activity, decide the minimal set of updates so a lead or peer sees the truth right now.

Return ONLY a JSON object with these optional fields (omit or null = leave unchanged):
- "headline": the single best "what are they doing this moment" line. Keep it tight.
- "goal": the current session/task objective (more stable than headline).
- "status": "active" | "blocked" | "idle".
- "working_on": array of files/areas currently in play (replaces the list).
- "timeline_add": array of {kind: did|decided|blocked|started, summary} — ONLY genuinely NEW
  events (a real step, decision, or block). NEVER restate the headline. Usually 0-1 items.
- "pending_add": array of strings — new things a PEER could pick up or that must not be forgotten.
  Don't duplicate existing open pending items.
- "pending_resolve": array of existing pending ids that the new facts show are now done.

If nothing meaningful changed, return {}. Be conservative; do not invent.`;

export async function reconcile(input: {
  project: string;
  member: string;
  facts: Extract;
}): Promise<void> {
  const { project, member, facts } = input;

  const current: any =
    db.prepare("SELECT * FROM members WHERE project = ? AND member = ?").get(project, member) ?? {};
  const openPending = findOpenPending(project, member);

  const ops = await jsonComplete({
    schema: ReconcileSchema,
    system: SYSTEM,
    maxTokens: 3000,
    user: `CURRENT STATE
headline: ${current.headline || "(none)"}
goal: ${current.goal || "(none)"}
status: ${current.status || "idle"}
working_on: ${current.working_on || "[]"}
open_pending:
${openPending.map((p) => `  - [${p.id}] ${p.text}`).join("\n") || "  (none)"}

EXTRACTED FACTS FROM LATEST ACTIVITY
intent: ${facts.intent}
actions: ${facts.actions.join(" | ") || "-"}
files: ${facts.files.join(", ") || "-"}
decisions: ${facts.decisions.join(" | ") || "-"}
blockers: ${facts.blockers.join(" | ") || "-"}
next_steps: ${facts.next_steps.join(" | ") || "-"}`,
  });

  applyOps(project, member, ops);
}
