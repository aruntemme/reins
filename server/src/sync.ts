/**
 * Cross-instance sync over 0G Storage.
 *
 * A project's context pack is content-addressed by its 0G Storage Merkle root
 * hash. That hash is the ONLY thing a second Reins instance needs to reconstruct
 * the same shared brain: syncPush uploads the pack and returns the hash, syncPull
 * downloads it by hash alone and merges it into a local DB. The merge step is a
 * pure, idempotent local operation so re-pulling the same hash (or pushing then
 * pulling on the same machine) never duplicates state.
 */
import {
  ensureProject,
  setGoal,
  getProject,
  upsertMemberState,
  upsertPending,
  saveRollup,
  recordSnapshot,
  setRollupProvenance,
  db,
} from "./db.js";
import { buildContextPack, type ContextPack } from "./context-pack.js";
import { putSnapshot, getSnapshot } from "./llm/og-storage.js";

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
  // fresh pull seeds the goal without clobbering a goal the local team chose.
  if (pack.goal) {
    const local: any = getProject(project);
    if (!local?.goal) setGoal(project, pack.goal, "0g-sync");
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

/**
 * Push a project's current context pack to 0G Storage. Builds the pack from the
 * live DB, uploads it, records the snapshot in the ledger, and stamps the rollup
 * with its 0G provenance. Returns the content address (root hash) + upload tx.
 */
export async function syncPush(project: string): Promise<{ rootHash: string; txHash: string }> {
  const pack = buildContextPack(project);
  const { rootHash, txHash } = await putSnapshot(pack);

  const ws = (getProject(project) as any)?.workspace_id || "default";
  recordSnapshot({ workspaceId: ws, project, rootHash, txHash });
  // Stamp the rollup pointer so reins_context serves THIS verified snapshot.
  setRollupProvenance(project, rootHash, txHash);

  return { rootHash, txHash };
}

/**
 * Pull a context pack from 0G Storage by root hash alone and merge it locally.
 * Returns a small summary of what was merged.
 */
export async function syncPull(
  rootHash: string,
  targetProject?: string
): Promise<{ project: string; members: number; pending: number }> {
  const pack = await getSnapshot<ContextPack>(rootHash);
  const project = targetProject || pack.project;
  mergePack(pack, project);
  return { project, members: pack.members.length, pending: pack.pending.length };
}
