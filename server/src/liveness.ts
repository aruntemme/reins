/**
 * Member liveness, derived from last activity time.
 *
 * The stored `status` (active | blocked | idle) is set by the distillation
 * pipeline from events and NEVER decays on its own — so a teammate who has gone
 * quiet for days still reads as "active". That misleads the rollup into
 * coordinating live people with ghosts (collisions/nudges to someone who isn't
 * here). Liveness fixes that at read time:
 *
 *   active  — signalled within STALE_MS (currently working)
 *   idle    — quiet for a while but still same-session
 *   away    — silent past AWAY_MS; not participating right now
 */
const MIN = 60 * 1000;

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// No longer "live" after this much silence (matches the dashboard's STALE window).
export const STALE_MS = num("REINS_STALE_MS", 20 * MIN);
// Treated as "away" (not currently participating) after this. Default 24h so an
// overnight gap doesn't flag someone away, but a multi-day absence does.
export const AWAY_MS = num("REINS_AWAY_MS", 24 * 60 * MIN);

export type Liveness = "active" | "idle" | "away";

export function liveness(lastSeen: number | null | undefined, at: number = Date.now()): Liveness {
  const age = at - (lastSeen ?? 0);
  if (age < STALE_MS) return "active";
  if (age < AWAY_MS) return "idle";
  return "away";
}

/** Human label for prompts/UX: "active", "idle 3h", "AWAY 2d". */
export function livenessLabel(lastSeen: number | null | undefined, at: number = Date.now()): string {
  const l = liveness(lastSeen, at);
  if (l === "active") return "active";
  const hours = (at - (lastSeen ?? 0)) / (60 * MIN);
  const ago = hours < 24 ? `${Math.max(1, Math.round(hours))}h` : `${Math.round(hours / 24)}d`;
  return l === "idle" ? `idle ${ago}` : `AWAY ${ago}`;
}

/**
 * Whether a synthesized handoff may be directed at a recipient of this liveness.
 * An away teammate isn't here to act on coordination noise, so fyi/collision to
 * them is dropped — but a genuine `blocker` is kept, so the owner sees it on
 * return (the worst-case we DO want recorded).
 */
export function handoffAllowed(recipient: Liveness, kind: string): boolean {
  return recipient !== "away" || kind === "blocker";
}
