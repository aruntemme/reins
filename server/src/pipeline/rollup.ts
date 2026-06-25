import {
  listMembers,
  listPending,
  getProject,
  saveRollup,
  setRollupProvenance,
  recordSnapshot,
  projectWorkspace,
  resolveMember,
  createHandoff,
} from "../db.js";
import { jsonComplete } from "../llm/client.js";
import { bus } from "../bus.js";
import { env } from "../env.js";
import { putSnapshot } from "../llm/og-storage.js";
import { buildContextPack } from "../context-pack.js";
import { RollupSchema } from "./schemas.js";

const SYSTEM = `You are the project synthesizer of Reins. Given the live state of every teammate
and the project goal, produce a crisp project-level rollup for a lead. Be honest about drift,
stalls, and collisions (two people in the same area). Don't pad. Also emit directed "handoffs":
when two people edit the same file, send a "collision" handoff to EACH of them; when someone is
blocked on something a teammate owns, send a "blocker" handoff to the owner. Use exact roster names.
Respond ONLY as JSON:
{summary, alignment, collisions[{area,members[],note}], risks[], handoffs[{to,from,kind,reason}]}.
"kind" is one of collision|blocker|fyi. "from" may be "" for a team-level nudge.`;

// Debounce per project so a burst of events produces one rollup.
const pending = new Map<string, NodeJS.Timeout>();

export function scheduleRollup(project: string, delayMs = 4000) {
  const existing = pending.get(project);
  if (existing) clearTimeout(existing);
  pending.set(
    project,
    setTimeout(() => {
      pending.delete(project);
      void runRollup(project).catch((e) => console.error("[rollup]", e.message));
    }, delayMs)
  );
}

export async function runRollup(project: string): Promise<void> {
  const proj = getProject(project);
  const members = listMembers(project);
  if (members.length === 0) return;
  const pendingItems = listPending(project);

  const memberBlock = members
    .map(
      (m) =>
        `- ${m.display_name || m.member} [${m.status}]: ${m.headline || "(no headline)"}` +
        (m.goal ? `\n    goal: ${m.goal}` : "") +
        (m.working_on && m.working_on !== "[]" ? `\n    working_on: ${m.working_on}` : "")
    )
    .join("\n");

  const pendingBlock =
    pendingItems.map((p) => `- (${p.member}) ${p.text} [${p.status}]`).join("\n") || "(none)";

  const r = await jsonComplete({
    schema: RollupSchema,
    system: SYSTEM,
    user: `PROJECT: ${proj?.name || project}
GOAL: ${proj?.goal || "(not set)"}

TEAM (live):
${memberBlock}

PENDING / UP-FOR-GRABS:
${pendingBlock}`,
    maxTokens: 3500,
  });

  saveRollup(project, r);
  bus.emitChange({ type: "rollup.updated", project });

  // Persist the canonical Context Pack to 0G Storage so the shared context is
  // verifiable and portable: addressable by Merkle root hash, not locked in one
  // server's DB. The MCP retrieval reads this exact pack back FROM 0G Storage.
  if (env.og.storageEnabled) {
    void putSnapshot(buildContextPack(project))
      .then(({ rootHash, txHash }) => {
        setRollupProvenance(project, rootHash, txHash);
        // Append to the snapshot ledger (history of every 0G Storage write).
        // Cross-instance sync reads it; chain anchoring fills anchored_tx.
        recordSnapshot({ workspaceId: projectWorkspace(project) ?? "default", project, rootHash, txHash });
        bus.emitChange({ type: "rollup.updated", project });
        console.log(`[0g-storage] ${project} context pack -> ${rootHash}`);
      })
      .catch((e) => console.error("[0g-storage]", e.message));
  }

  // Turn synthesized cross-team nudges into directed handoffs (deduped).
  let handed = false;
  for (const h of r.handoffs ?? []) {
    const toId = resolveMember(project, h.to);
    if (!toId) continue;
    const fromId = h.from ? resolveMember(project, h.from) ?? undefined : undefined;
    if (fromId === toId) continue;
    const created = createHandoff({
      project,
      toMember: toId,
      fromMember: fromId,
      kind: h.kind,
      text: h.reason,
    });
    if (created) handed = true;
  }
  if (handed) bus.emitChange({ type: "handoff.changed", project });
}
