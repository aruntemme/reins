import {
  listMembers,
  listPending,
  getProject,
  saveRollup,
  resolveMember,
  createHandoff,
  projectWorkspace,
  PROMPT_LIST_CAP,
  projectHidesBranches,
} from "../db.js";
import { jsonComplete } from "../llm/client.js";
import { fileOverlaps, computeOverlaps, presentWork, reconcileCollisions } from "../collisions.js";
import { handoffConventions } from "../context-pack.js";
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

FILE OVERLAPS (when listed) are computed from each present teammate's real edits, uncommitted git
changes, working_on, and shared branches — treat them as facts: report each as a collision. Their
collision handoffs are already sent, so don't repeat them.

For a "blocker" that waits on a listed PENDING item, set "pending_id" to that item's exact [id].

AWAY teammates (flagged below) have been silent a long time and are NOT participating now: never
invent collisions, fyi, or nudges involving them. The ONLY handoff you may direct to an away
teammate is a genuine "blocker" — when a present teammate truly needs something only that away
person owns — so they see it on return.

Use exact roster names. Respond ONLY as JSON:
{summary, alignment, collisions[{area,members[],note}], risks[], handoffs[{to,from,kind,reason,pending_id?}]}.
"kind" is one of collision|blocker|fyi. "from" may be "" for a team-level note.`;

// Debounce per project so a burst of events produces one rollup — and run each
// project's rollup at most once per MIN_INTERVAL_MS. A request inside the
// interval becomes ONE trailing run at the interval's end, and a pending run is
// never pushed past MIN_INTERVAL_MS from when it was first requested, so a
// continuously busy project still gets a fresh rollup (no starvation).
const MIN_INTERVAL_MS = Math.max(0, Number(process.env.REINS_ROLLUP_MIN_INTERVAL_MS ?? 60_000) || 0);
const pending = new Map<string, { timer: NodeJS.Timeout; deadline: number }>();
const lastRun = new Map<string, number>();

export function scheduleRollup(project: string, delayMs = 4000) {
  const now = Date.now();
  const existing = pending.get(project);
  if (existing) clearTimeout(existing.timer);
  const deadline = existing?.deadline ?? now + Math.max(delayMs, MIN_INTERVAL_MS);
  const earliest = (lastRun.get(project) ?? 0) + MIN_INTERVAL_MS;
  const at = Math.max(Math.min(now + delayMs, deadline), earliest);
  pending.set(project, {
    deadline,
    timer: setTimeout(() => {
      pending.delete(project);
      void runRollup(project).catch((e) => console.error("[rollup]", e.message));
    }, Math.max(0, at - now)),
  });
}

// fileOverlaps moved to collisions.ts (shared with the live board and the hook's
// pre-edit check); re-exported here for existing callers.
export { fileOverlaps };

export async function runRollup(project: string): Promise<void> {
  const proj = getProject(project);
  const members = listMembers(project);
  if (members.length === 0) return;
  lastRun.set(project, Date.now());
  const pendingItems = listPending(project).slice(0, PROMPT_LIST_CAP);
  const hideBranches = projectHidesBranches(project);

  // Liveness derived from last activity, so the synthesizer doesn't coordinate
  // live teammates with members who have gone quiet for days.
  const live = (m: any) => liveness(m.last_seen);
  const present = members.filter((m) => live(m) !== "away");
  const away = members.filter((m) => live(m) === "away");
  // Files each present member really touched recently (from the hook, not inferred).
  const touched = new Map<string, string[]>();
  for (const w of presentWork(project)) touched.set(w.member, w.touched.slice(0, 8).map((t) => t.path));

  const memberBlock =
    present
      .map(
        (m) =>
          `- ${m.display_name || m.member} [${livenessLabel(m.last_seen)}]: ${m.headline || "(no headline)"}` +
          (m.goal ? `\n    goal: ${m.goal}` : "") +
          (m.working_on && m.working_on !== "[]" ? `\n    working_on: ${m.working_on}` : "") +
          (touched.get(m.member)?.length ? `\n    edited (last 30m): ${touched.get(m.member)!.join(", ")}` : "") +
          (m.branch && !hideBranches ? `\n    branch: ${m.branch}` : "")
      )
      .join("\n") || "(nobody active right now)";

  const awayBlock = away.length
    ? "\n\nAWAY (not participating — do NOT invent collisions/fyi for these):\n" +
      away
        .map((m) => `- ${m.display_name || m.member} [${livenessLabel(m.last_seen)}], last: ${m.headline || "(no headline)"}`)
        .join("\n")
    : "";

  const pendingBlock =
    pendingItems.map((p) => `- [${p.id}] (${p.member}) ${p.text} [${p.status}]`).join("\n") || "(none)";

  // Collisions are computed, not guessed: shared files (real edits, uncommitted
  // changes, working_on) and shared non-default branches among PRESENT teammates
  // (an away member's stale state never collides).
  const nameOf = new Map(members.map((m: any) => [m.member, m.display_name || m.member]));
  const overlaps = computeOverlaps(project);
  const overlapBlock = overlaps.length
    ? "\n\nFILE OVERLAPS (computed from edits, git, and working_on — facts):\n" +
      overlaps.map((o) => `- ${o.area}: ${o.members.map((id) => nameOf.get(id)).join(", ")}`).join("\n")
    : "";

  const r = await jsonComplete({
    schema: RollupSchema,
    system: SYSTEM,
    user: `PROJECT: ${proj?.name || project}
GOAL: ${proj?.goal || "(not set)"}

TEAM (present):
${memberBlock}${awayBlock}${overlapBlock}

PENDING / UP-FOR-GRABS:
${pendingBlock}`,
    maxTokens: 3500,
    workspaceId: projectWorkspace(project) ?? "default",
  });

  // The computed overlaps are facts: make sure each shows on the board even if the
  // model left it out, and tag the model's own copy of one as computed, so the
  // live board (and the auto-close check) treats it as the live overlap it is.
  const idsOf = (names: string[]) => names.map((n) => resolveMember(project, n)).filter(Boolean) as string[];
  const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
  const collisions: { area: string; members: string[]; note: string; computed?: boolean }[] = r.collisions.map((c) =>
    overlaps.some((o) => sameSet(idsOf(c.members), o.members)) ? { ...c, computed: true } : c
  );
  for (const o of overlaps) {
    const known = collisions.some((c) => c.computed && sameSet(idsOf(c.members), o.members));
    if (!known) {
      collisions.push({
        area: o.area,
        members: o.members.map((id) => nameOf.get(id)!),
        note: o.kind === "file" ? "both are working on this file" : "both are on this branch",
        computed: true,
      });
    }
  }
  // A collision handoff the model emitted implies a collision it saw (in an area the
  // computation can't): record it, so the auto-close check keeps that pair open.
  const extraPairs: [string, string][] = [];
  for (const h of r.handoffs ?? []) {
    if (h.kind !== "collision") continue;
    const to = resolveMember(project, h.to);
    const from = h.from ? resolveMember(project, h.from) : null;
    if (!to || !from || to === from) continue;
    extraPairs.push([to, from]);
    if (!collisions.some((c) => sameSet(idsOf(c.members), [to, from].sort()))) {
      collisions.push({ area: "shared work", members: [nameOf.get(from)!, nameOf.get(to)!], note: h.reason.slice(0, 200) });
    }
  }

  saveRollup(project, { ...r, collisions });
  bus.emitChange({ type: "rollup.updated", project });

  // Workstream F: fan the fresh rollup out to chat. Fire-and-forget so a slow or
  // down webhook never blocks the pipeline; postDigest is a no-op when neither
  // Slack nor Discord webhook is configured and swallows all errors internally.
  // The webhooks are the OPERATOR's (env), so only the single-tenant case posts
  // to them — never another workspace's summaries.
  const ws = projectWorkspace(project) ?? "default";
  const operatorsOwn = !env.authEnabled || ws === "default";
  if (operatorsOwn && (env.integrations.slackWebhook || env.integrations.discordWebhook)) {
    void postDigest(project, proj?.name || project, { ...r, collisions }).catch((e) =>
      console.error("[digest]", e.message)
    );
  }

  // Turn synthesized cross-team nudges into directed handoffs (deduped).
  // Liveness by member id, to backstop the prompt: even if the model emits one,
  // a manufactured fyi/collision to an away teammate is dropped — only a real
  // blocker reaches them (they'll see it on return).
  const liveById = new Map(members.map((m: any) => [m.member, liveness(m.last_seen)]));
  const pendingIds = new Set(pendingItems.map((p) => p.id));
  let handed = false;
  for (const h of r.handoffs ?? []) {
    const toId = resolveMember(project, h.to);
    if (!toId) continue;
    const recip = liveById.get(toId) ?? "active";
    if (!handoffAllowed(recip, h.kind)) continue;
    const fromId = h.from ? resolveMember(project, h.from) ?? undefined : undefined;
    if (fromId === toId) continue;
    // A blocker tied to a listed pending item auto-closes once that item is done.
    const ref = h.kind === "blocker" && h.pending_id && pendingIds.has(h.pending_id) ? h.pending_id : null;
    const created = createHandoff({
      project,
      toMember: toId,
      fromMember: fromId,
      kind: h.kind,
      text: h.reason,
      ref,
      conventions: h.kind === "blocker" ? handoffConventions(project, toId, h.reason) : null,
    });
    if (created) handed = true;
  }
  if (handed) bus.emitChange({ type: "handoff.changed", project });
  // Deterministic collision handoffs (one to each teammate per overlapping peer)
  // and auto-closing whatever no longer applies.
  reconcileCollisions(project, { extraPairs });
}
