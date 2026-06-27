import { db, findOpenPending, listMembers, resolveMember, createHandoff } from "../db.js";
import { jsonComplete } from "../llm/client.js";
import { getProject, openGoalItemsForMatch, openGoalsForMatch, applyGoalOps, openTraitsForMatch, applyTraitOps } from "../db.js";
import { bus } from "../bus.js";
import { DistillSchema } from "./schemas.js";
import { applyOps } from "./reconcile.js";

const SYSTEM = `You are the distiller of Reins — you maintain a teammate's LIVING CONTEXT on a
shared team board, from a stream of signals emitted by their AI coding agent. In ONE pass you:
  1) TRIAGE the new event — is it noise, minor, or major?
  2) EXTRACT what actually happened (intent, actions, decisions, blockers, next steps).
  3) RECONCILE it into the board as a minimal op-set.

Return ONLY a JSON object:
- "significance": "noise" | "minor" | "major". "noise" = no informational content (ran ls, "ok",
  formatting, empty/garbled) -> return significance only and omit everything else. A teammate
  stating what they're doing / did / decided / is blocked on is ALWAYS at least "minor".
- "headline": the single best "what are they doing this moment" line (tight). Omit/null if unchanged.
- "goal": current session/task objective (more stable than headline). Omit/null if unchanged.
- "status": "active" | "blocked" | "idle". Omit/null if unchanged.
- "working_on": array of files/areas now in play (replaces the list). Omit/null if unchanged.
- "timeline_add": array of {kind: did|decided|blocked|started, summary} — ONLY genuinely NEW events.
  Never restate the headline. Usually 0-1 items.
- "pending_add": array of strings a PEER could pick up or that must not be forgotten. No duplicates of open pending.
- "pending_resolve": ids of existing open pending items the new facts show are now done.
- "mentions": array of {to, note} — when this person directly flags, @mentions, or hands work to a
  named teammate ("heads up Praveen…", "@asha can you…", "blocked on the API Ravi owns"). "to" MUST
  be an exact name from the TEAMMATE ROSTER; drop mentions of anyone not on it. "note" = what that
  teammate needs to do or know. Empty array if none.
- "goal_ops": PROPOSED goal updates (a human confirms them later — so be precise, not eager). Using
  ONLY the ids in OPEN GOAL ITEMS / GOALS below: "check_item" {itemId, reason} when the event clearly
  shows that item is DONE; "add_item" {goalId, text, reason} when the work is a concrete sub-task of a
  listed goal not already an item; "block_goal" {goalId, reason} when clearly blocked on it. Empty if
  unsure — a wrong proposal wastes the owner's time.
- "trait_ops": the person's durable WORKING GRAIN (taste) — how they like to work, NOT this one task.
  "reinforce" {traitId, evidence} when the event re-confirms a trait in MY TASTE PROFILE below; "revise"
  {traitId, type, statement, evidence} to sharpen one; "add" {type, statement, evidence} for a clear new
  preference not listed. Be conservative — prefer reinforce, add rarely, empty for routine work. CRITICAL:
  evidence is a SHORT PARAPHRASE of the signal — never the raw prompt, code, secrets, paths, or identifiers.

Be faithful — never invent. If nothing meaningful changed, return just the significance.`;

export async function distillCombined(input: {
  project: string;
  member: string;
  text: string;
  eventId?: string;
}): Promise<"noise" | "minor" | "major"> {
  const { project, member, text, eventId } = input;
  const current: any =
    db.prepare("SELECT * FROM members WHERE project = ? AND member = ?").get(project, member) ?? {};
  const openPending = findOpenPending(project, member);
  const proj = getProject(project);
  const roster = listMembers(project)
    .map((x) => x.display_name || x.member)
    .filter((n) => n !== (current.display_name || member));
  const goalItems = openGoalItemsForMatch(project, member);
  const goals = openGoalsForMatch(project, member);
  const traits = openTraitsForMatch(project, member);

  const ops = await jsonComplete({
    schema: DistillSchema,
    system: SYSTEM,
    maxTokens: 3500,
    user: `PROJECT GOAL (for relevance): ${proj?.goal || "(not set)"}
TEAMMATE ROSTER (use these exact names for mentions): ${roster.join(", ") || "(no other teammates yet)"}

CURRENT STATE for ${current.display_name || member}
headline: ${current.headline || "(none)"}
goal: ${current.goal || "(none)"}
status: ${current.status || "idle"}
working_on: ${current.working_on || "[]"}
open_pending:
${openPending.map((p) => `  - [${p.id}] ${p.text}`).join("\n") || "  (none)"}

OPEN GOAL ITEMS (for goal_ops check_item — use the exact item id):
${goalItems.map((g) => `  - item ${g.itemId} :: "${g.text}" (${g.scope} goal: ${g.goalTitle})`).join("\n") || "  (none)"}
GOALS (for goal_ops add_item / block_goal — use the exact goal id):
${goals.map((g) => `  - goal ${g.id} :: "${g.title}" (${g.scope})`).join("\n") || "  (none)"}

MY TASTE PROFILE for ${current.display_name || member} (for trait_ops reinforce/revise — use the exact trait id):
${traits.map((t) => `  - trait ${t.id} :: [${t.type}] "${t.statement}"`).join("\n") || "  (none yet)"}

NEW EVENT FROM THEIR AGENT:
${text}`,
  });

  if (ops.significance === "noise") return "noise";
  applyOps(project, member, ops);

  // Goal auto-tracking: file the proposed goal_ops for the owner to confirm.
  if (ops.goal_ops?.length) {
    const filed = applyGoalOps(project, member, ops.goal_ops, eventId);
    if (filed > 0) bus.emitChange({ type: "goals.changed", project });
  }

  // Taste profile: learn/reinforce the member's working grain from this signal.
  // Applied directly (not a proposal) — it's an evolving, decaying, member-editable
  // abstraction, never the raw prompt, so a stray trait is low-cost and fades.
  if (ops.trait_ops?.length) {
    const changed = applyTraitOps(project, member, ops.trait_ops as any);
    if (changed > 0) bus.emitChange({ type: "profile.changed", project, member });
  }

  // @mentions -> directed handoffs to the named teammate.
  let handed = false;
  for (const mention of ops.mentions ?? []) {
    const toId = resolveMember(project, mention.to);
    if (!toId || toId === member) continue; // must be a real, different teammate
    const created = createHandoff({
      project,
      toMember: toId,
      fromMember: member,
      kind: "mention",
      text: mention.note,
    });
    if (created) handed = true;
  }
  if (handed) bus.emitChange({ type: "handoff.changed", project });

  return ops.significance;
}
