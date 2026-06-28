import {
  ensureProject,
  ensureMember,
  touchMember,
  insertEvent,
  setEventSignificance,
  getProject,
  addTimeline,
} from "../db.js";
import { llmConfigured } from "../llm/client.js";
import { redactSecrets } from "../redact.js";
import { bus } from "../bus.js";
import { triage } from "./triage.js";
import { extract } from "./extract.js";
import { reconcile } from "./reconcile.js";
import { distillCombined } from "./distill.js";
import { scheduleRollup } from "./rollup.js";
import { enqueueDistill } from "./queue.js";

// "combined" = 1 LLM call/event (default — robust on rate-limited endpoints).
// "multi"    = staged triage -> extract -> reconcile (3 calls/event).
const PIPELINE_MODE = (process.env.REINS_PIPELINE_MODE || "combined").toLowerCase();

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
  input.text = redactSecrets(input.text);

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
      // distill() already degrades gracefully on an LLM failure (raw timeline
      // fallback). Reaching here means something unexpected slipped past that
      // guard; log it, but the event is already persisted so we never lose it.
      console.error("[pipeline]", input.project, input.member, e?.message ?? e);
    } finally {
      const n = (inflight.get(input.project) ?? 1) - 1;
      inflight.set(input.project, n);
      // On throttled endpoints distills land far apart, so a fixed timer would
      // fire mid-drain on a half-distilled board; gate on the project's queue.
      if (n <= 0) scheduleRollup(input.project, 1500);
    }
  });

  return { eventId };
}

// In-flight distillation count per project (queued + running; gates the rollup).
const inflight = new Map<string, number>();

async function distill(eventId: string, input: IngestInput): Promise<void> {
  if (!llmConfigured) {
    // No LLM configured: degrade gracefully — log a raw timeline entry so the
    // board still shows life, just without distillation.
    rawFallback(input);
    return;
  }

  try {
    if (PIPELINE_MODE === "multi") {
      const t = await triage({ kind: input.kind, text: input.text });
      setEventSignificance(eventId, t.significance);
      if (t.significance === "noise") return;

      const proj = getProject(input.project);
      const facts = await extract({
        member: input.member,
        text: input.text,
        projectGoal: proj?.goal ?? "",
      });
      await reconcile({ project: input.project, member: input.member, facts });
    } else {
      const sig = await distillCombined({
        project: input.project,
        member: input.member,
        text: input.text,
        eventId,
      });
      setEventSignificance(eventId, sig);
    }
  } catch (e: any) {
    // The LLM backend failed mid-distill — provider out of balance (402),
    // throttled past our retry budget (429), or a malformed response. Without a
    // fallback the timeline silently stalls while the signal timestamp keeps
    // moving (touchMember is synchronous), so the board looks alive but frozen.
    // Degrade to a raw timeline entry so activity stays visible until the
    // provider recovers; the raw event is already persisted regardless.
    console.error("[pipeline]", input.project, input.member, "distill failed, raw fallback:", e?.message ?? e);
    rawFallback(input);
  }
  // Rollup is scheduled by the settle-gate in ingest() once the queue drains.
}

/**
 * Degraded path: write the captured text straight to the timeline when the
 * distiller is unavailable (no LLM configured, or the provider failed). Skips
 * trivial/empty captures so an outage doesn't flood the board with "ok"/"ls"
 * noise the distiller would normally drop. Secrets are already redacted upstream.
 */
function rawFallback(input: IngestInput): void {
  const text = input.text.trim();
  if (text.length < 12) return; // too thin to be a useful timeline entry
  addTimeline(input.project, input.member, "did", text.slice(0, 200));
  bus.emitChange({ type: "timeline.added", project: input.project, member: input.member });
}
