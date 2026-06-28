import {
  listMembers,
  listPending,
  getProject,
  saveRollup,
  resolveMember,
  createHandoff,
  projectWorkspace,
} from "../db.js";
import { jsonComplete } from "../llm/client.js";
import { bus } from "../bus.js";
import { env } from "../env.js";
import { liveness, livenessLabel, handoffAllowed } from "../liveness.js";
import { RollupSchema } from "./schemas.js";
import { postDigest } from "../integrations/digest.js";

const SYSTEM = `You are the project synthesizer of Reins. Given the live state of every teammate
and the project goal, produce a crisp project-level rollup for a lead. Be honest about drift,
stalls, and collisions (two people in the same area). Don't pad.

Emit directed "handoffs" ONLY when there is a concrete, actionable coordination need:
- "collision": two PRESENT teammates are editing the same file/area right now — send one to EACH.
- "blocker": a present teammate is blocked on work a specific teammate owns — send to that owner.
Do NOT emit "fyi"/nudge handoffs for status updates, and do NOT nag anyone about a missing,
empty, or vague headline/goal — that is noise, not a handoff. If nothing needs coordination,
return an empty handoffs array. Prefer fewer, higher-signal handoffs.

AWAY teammates (flagged below) have been silent a long time and are NOT participating now: never
invent collisions, fyi, or nudges involving them. The ONLY handoff you may direct to an away
teammate is a genuine "blocker" — when a present teammate truly needs something only that away
person owns — so they see it on return.

Use exact roster names. Respond ONLY as JSON:
{summary, alignment, collisions[{area,members[],note}], risks[], handoffs[{to,from,kind,reason}]}.
"kind" is one of collision|blocker|fyi. "from" may be "" for a team-level note.`;

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

  // Liveness derived from last activity, so the synthesizer doesn't coordinate
  // live teammates with members who have gone quiet for days.
  const live = (m: any) => liveness(m.last_seen);
  const present = members.filter((m) => live(m) !== "away");
  const away = members.filter((m) => live(m) === "away");

  const memberBlock =
    present
      .map(
        (m) =>
          `- ${m.display_name || m.member} [${livenessLabel(m.last_seen)}]: ${m.headline || "(no headline)"}` +
          (m.goal ? `\n    goal: ${m.goal}` : "") +
          (m.working_on && m.working_on !== "[]" ? `\n    working_on: ${m.working_on}` : "")
      )
      .join("\n") || "(nobody active right now)";

  const awayBlock = away.length
    ? "\n\nAWAY (not participating — do NOT invent collisions/fyi for these):\n" +
      away
        .map((m) => `- ${m.display_name || m.member} [${livenessLabel(m.last_seen)}], last: ${m.headline || "(no headline)"}`)
        .join("\n")
    : "";

  const pendingBlock =
    pendingItems.map((p) => `- (${p.member}) ${p.text} [${p.status}]`).join("\n") || "(none)";

  const r = await jsonComplete({
    schema: RollupSchema,
    system: SYSTEM,
    user: `PROJECT: ${proj?.name || project}
GOAL: ${proj?.goal || "(not set)"}

TEAM (present):
${memberBlock}${awayBlock}

PENDING / UP-FOR-GRABS:
${pendingBlock}`,
    maxTokens: 3500,
    workspaceId: projectWorkspace(project) ?? "default",
  });

  saveRollup(project, r);
  bus.emitChange({ type: "rollup.updated", project });

  // Workstream F: fan the fresh rollup out to chat. Fire-and-forget so a slow or
  // down webhook never blocks the pipeline; postDigest is a no-op when neither
  // Slack nor Discord webhook is configured and swallows all errors internally.
  if (env.integrations.slackWebhook || env.integrations.discordWebhook) {
    void postDigest(project, proj?.name || project, r).catch((e) =>
      console.error("[digest]", e.message)
    );
  }

  // Turn synthesized cross-team nudges into directed handoffs (deduped).
  // Liveness by member id, to backstop the prompt: even if the model emits one,
  // a manufactured fyi/collision to an away teammate is dropped — only a real
  // blocker reaches them (they'll see it on return).
  const liveById = new Map(members.map((m: any) => [m.member, liveness(m.last_seen)]));
  let handed = false;
  for (const h of r.handoffs ?? []) {
    const toId = resolveMember(project, h.to);
    if (!toId) continue;
    const recip = liveById.get(toId) ?? "active";
    if (!handoffAllowed(recip, h.kind)) continue;
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
