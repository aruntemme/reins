import {
  ensureProject,
  ensureMember,
  touchMember,
  insertEvent,
  setEventSignificance,
  getProject,
  addTimeline,
  undistilledEvents,
  projectWorkspace,
} from "../db.js";
import { llmConfigured, backendKey } from "../llm/client.js";
import { redactSecrets } from "../redact.js";
import { bus } from "../bus.js";
import { triage } from "./triage.js";
import { extract } from "./extract.js";
import { reconcile } from "./reconcile.js";
import { distillCombined } from "./distill.js";
import { scheduleRollup } from "./rollup.js";
import { enqueueDistill, pauseDistill, distillQueueDepth } from "./queue.js";
import { applyGitMeta } from "../collisions.js";

// "combined" = 1 LLM call/event (default — robust on rate-limited endpoints).
// "multi"    = staged triage -> extract -> reconcile (3 calls/event).
const PIPELINE_MODE = (process.env.REINS_PIPELINE_MODE || "combined").toLowerCase();

// Server-side cap on stored/distilled event text (the hook caps at 6k already;
// this bounds what any other client can make us store and pay to distill).
export const MAX_EVENT_TEXT = 8000;
// On boot, events younger than this that never finished distilling are re-queued.
const RECOVER_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface IngestInput {
  project: string;
  member: string;
  displayName?: string;
  kind: string; // intent | progress | summary
  text: string;
  session?: string;
  meta?: unknown;
  source?: string; // which agent harness captured this (default: claude-code)
  workspaceId?: string;
}

/**
 * Full distillation pipeline for one event:
 *   triage (gate) -> extract (facts) -> reconcile (agentic merge) -> schedule rollup
 * Runs async; the HTTP handler returns immediately after persisting the raw event.
 */
export async function ingest(input: IngestInput): Promise<{ eventId: string }> {
  // Mask any credential in the captured text BEFORE it is stored or seen by the
  // LLM, so a leaked key never lands in the event store or a distilled summary.
  input.text = redactSecrets(input.text).slice(0, MAX_EVENT_TEXT);

  ensureProject(input.project, undefined, input.workspaceId ?? "default");
  ensureMember(input.project, input.member, input.displayName);
  touchMember(input.project, input.member);

  const eventId = insertEvent({
    project: input.project,
    member: input.member,
    kind: input.kind,
    text: input.text,
    session: input.session,
    meta: input.meta,
    source: input.source,
  });

  bus.emitChange({ type: "ingest", project: input.project, member: input.member });
  // Git state (branch, dirty files, a detected merge) and the deterministic
  // collision check run inline — no LLM, so they show on the board right away.
  try {
    applyGitMeta(input.project, input.member, input.meta, { eventId, kind: input.kind, text: input.text });
  } catch (e: any) {
    console.error("[git]", input.project, input.member, e?.message ?? e);
  }
  enqueueEvent(eventId, input);
  return { eventId };
}

function enqueueEvent(eventId: string, input: IngestInput): void {
  const workspaceId = input.workspaceId ?? "default";
  // Distillation runs through a serial queue (not fire-and-forget) so a burst of
  // events can't launch concurrent LLM calls into a rate-limited gateway. The
  // event is already persisted; the HTTP handler still returns immediately. The
  // inflight count now tracks queued + running work per project, so the rollup
  // still fires only once the board has SETTLED.
  inflight.set(input.project, (inflight.get(input.project) ?? 0) + 1);
  enqueueDistill(async () => {
    try {
      await distill(eventId, input);
    } catch (e: any) {
      console.error("[pipeline]", input.project, input.member, e?.message ?? e);
      // Final failure (retries exhausted): mark it so restart recovery doesn't
      // re-run a poison event forever.
      setEventSignificance(eventId, "error");
    } finally {
      const n = (inflight.get(input.project) ?? 1) - 1;
      inflight.set(input.project, n);
      // On throttled endpoints distills land far apart, so a fixed timer would
      // fire mid-drain on a half-distilled board; gate on the project's queue.
      if (n <= 0) scheduleRollup(input.project, 1500);
    }
  }, { lane: backendKey(workspaceId), key: `${input.project}\u0000${input.member}` });
}

/**
 * Restart recovery: the distill queue is in memory, so events that were queued
 * (or mid-flight) when the process stopped are still significance NULL in the
 * DB. Re-enqueue the recent ones, oldest first. Returns how many.
 */
export function recoverUndistilled(at = Date.now()): number {
  const events = undistilledEvents(at - RECOVER_WINDOW_MS);
  for (const e of events) {
    enqueueEvent(e.id, {
      project: e.project,
      member: e.member,
      kind: e.kind,
      text: e.text,
      source: e.source,
      workspaceId: projectWorkspace(e.project) ?? "default",
    });
  }
  return events.length;
}

/** Graceful shutdown: start no new distills, then wait (bounded) for the running
 *  ones. Anything still queued is recovered on the next boot. */
let draining = false;
/** False once shutdown has begun — ingest then answers 503 so the hook retries later. */
export const accepting = () => !draining;

export async function drainPipeline(timeoutMs: number): Promise<boolean> {
  draining = true;
  pauseDistill();
  const deadline = Date.now() + timeoutMs;
  while (distillQueueDepth().active > 0) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
}

// In-flight distillation count per project (queued + running; gates the rollup).
const inflight = new Map<string, number>();

async function distill(eventId: string, input: IngestInput): Promise<void> {
  const workspaceId = input.workspaceId ?? "default";
  if (!llmConfigured(workspaceId)) {
    // No LLM configured: degrade gracefully — log a raw timeline entry so the
    // board still shows life, just without distillation.
    addTimeline(input.project, input.member, "did", input.text.slice(0, 200));
    setEventSignificance(eventId, "raw"); // handled — never replay on restart
    bus.emitChange({ type: "timeline.added", project: input.project, member: input.member });
    return;
  }

  if (PIPELINE_MODE === "multi") {
    const t = await triage({ kind: input.kind, text: input.text, workspaceId });
    setEventSignificance(eventId, t.significance);
    if (t.significance === "noise") return;

    const proj = getProject(input.project);
    const facts = await extract({
      member: input.member,
      text: input.text,
      projectGoal: proj?.goal ?? "",
      workspaceId,
    });
    await reconcile({ project: input.project, member: input.member, facts, workspaceId });
  } else {
    const sig = await distillCombined({
      project: input.project,
      member: input.member,
      text: input.text,
      eventId,
      workspaceId,
    });
    setEventSignificance(eventId, sig);
  }
  // Rollup is scheduled by the settle-gate in ingest() once the queue drains.
}
