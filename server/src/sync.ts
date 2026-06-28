/**
 * Local context-pack merge.
 *
 * mergePack grafts a context pack (its members, pending items, goal, and rollup)
 * into the local DB. It is a pure, idempotent local operation: members are
 * upserted by (project, member), pending items are dedup-inserted by
 * (member, text), and the rollup is overwritten — so merging the same pack twice
 * never duplicates state.
 */
import {
  ensureProject,
  setGoal,
  getProject,
  upsertMemberState,
  upsertPending,
  saveRollup,
  db,
} from "./db.js";
import { type ContextPack } from "./context-pack.js";

/**
 * Merge a context pack into the local DB. PURE local operation, no network.
 *
 * Idempotent: members are upserted by (project, member); pending items are
 * dedup-inserted by (member, text) so merging the same pack twice does not
 * duplicate work; the rollup is overwritten with the pack's. `targetProject`
 * lets you graft another team's pack under a local project id; it defaults to
 * the pack's own project id.
 */
export function mergePack(pack: ContextPack, targetProject?: string): void {
  const project = targetProject || pack.project;
  ensureProject(project, pack.name);

  // Adopt the pack's goal when the local project hasn't set one of its own, so a
  // fresh merge seeds the goal without clobbering a goal the local team chose.
  if (pack.goal) {
    const local: any = getProject(project);
    if (!local?.goal) setGoal(project, pack.goal, "sync");
  }

  for (const m of pack.members) {
    upsertMemberState(project, m.member, {
      name: m.name,
      status: m.status,
      headline: m.headline,
      goal: m.goal,
      workingOn: m.workingOn,
    });
  }

  for (const p of pack.pending) {
    // Dedup across ALL statuses (not just open) so a re-merge never resurrects
    // or duplicates an item that already landed locally.
    const existing = db
      .prepare("SELECT id FROM pending WHERE project = ? AND member = ? AND text = ? LIMIT 1")
      .get(project, p.member, p.text) as { id: string } | undefined;
    if (!existing) upsertPending(project, p.member, p.text);
  }

  if (pack.rollup) {
    saveRollup(project, {
      summary: pack.rollup.summary,
      alignment: pack.rollup.alignment,
      collisions: pack.rollup.collisions,
      risks: pack.rollup.risks,
    });
  }
}
