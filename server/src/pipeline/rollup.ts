import {
  listMembers,
  listPending,
  getProject,
  saveRollup,
  resolveMember,
  createHandoff,
  projectWorkspace,
  PROMPT_LIST_CAP,
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

FILE OVERLAPS (when listed) are computed from each present teammate's working_on — treat them as
facts: report each as a collision. Their collision handoffs are already sent, so don't repeat them.

AWAY teammates (flagged below) have been silent a long time and are NOT participating now: never
invent collisions, fyi, or nudges involving them. The ONLY handoff you may direct to an away
teammate is a genuine "blocker" — when a present teammate truly needs something only that away
person owns — so they see it on return.

Use exact roster names. Respond ONLY as JSON:
{summary, alignment, collisions[{area,members[],note}], risks[], handoffs[{to,from,kind,reason}]}.
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

/** Normalize a working_on entry to a comparable file path, or null if it isn't
 *  path-like (free-text areas such as "auth refactor" are left to the LLM). */
function normPath(s: unknown): string | null {
  const p = String(s ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").toLowerCase();
  if (!p || /\s/.test(p) || !/[./]/.test(p)) return null;
  return p;
}

const samePath = (a: string, b: string) => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);

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

export async function runRollup(project: string): Promise<void> {
  const proj = getProject(project);
  const members = listMembers(project);
  if (members.length === 0) return;
  lastRun.set(project, Date.now());
  const pendingItems = listPending(project).slice(0, PROMPT_LIST_CAP);

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

  // File collisions are computed, not guessed: overlapping working_on paths among
  // PRESENT teammates (an away member's stale list never collides).
  const nameOf = new Map(members.map((m: any) => [m.member, m.display_name || m.member]));
  const overlaps = fileOverlaps(present);
  const overlapBlock = overlaps.length
    ? "\n\nFILE OVERLAPS (computed from working_on — facts):\n" +
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

  // The computed overlaps are facts: make sure each shows on the board even if
  // the model left it out.
  for (const o of overlaps) {
    const names = o.members.map((id) => nameOf.get(id)!);
    const known = r.collisions.some((c) => {
      const p = normPath(c.area);
      return !!p && samePath(p, o.area);
    });
    if (!known) r.collisions.push({ area: o.area, members: names, note: "both are working on this file" });
  }

  saveRollup(project, r);
  bus.emitChange({ type: "rollup.updated", project });

  // Workstream F: fan the fresh rollup out to chat. Fire-and-forget so a slow or
  // down webhook never blocks the pipeline; postDigest is a no-op when neither
  // Slack nor Discord webhook is configured and swallows all errors internally.
  // The webhooks are the OPERATOR's (env), so only the single-tenant case posts
  // to them — never another workspace's summaries.
  const ws = projectWorkspace(project) ?? "default";
  const operatorsOwn = !env.authEnabled || ws === "default";
  if (operatorsOwn && (env.integrations.slackWebhook || env.integrations.discordWebhook)) {
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
  // Deterministic collision handoffs, one to each teammate per overlapping peer.
  // createHandoff keeps one open collision per (to, from) and refreshes its text.
  for (const o of overlaps) {
    for (const to of o.members) {
      for (const from of o.members) {
        if (from === to) continue;
        const created = createHandoff({
          project,
          toMember: to,
          fromMember: from,
          kind: "collision",
          text: `You and ${nameOf.get(from)} are both working on ${o.area} — coordinate before editing it.`,
        });
        if (created) handed = true;
      }
    }
  }
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
