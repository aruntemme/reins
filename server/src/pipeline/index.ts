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
import { bus } from "../bus.js";
import { triage } from "./triage.js";
import { extract } from "./extract.js";
import { reconcile } from "./reconcile.js";
import { distillCombined } from "./distill.js";
import { scheduleRollup } from "./rollup.js";

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

  // Fire-and-forget distillation. Failures are logged, never block ingestion.
  inflight.set(input.project, (inflight.get(input.project) ?? 0) + 1);
  void distill(eventId, input)
    .catch((e) => console.error("[pipeline]", input.project, input.member, e?.message ?? e))
    .finally(() => {
      const n = (inflight.get(input.project) ?? 1) - 1;
      inflight.set(input.project, n);
      // Only synthesize the rollup once the board has SETTLED (queue idle for this
      // project). On throttled endpoints distills land far apart, so a fixed timer
      // would fire mid-drain on a half-distilled board.
      if (n <= 0) scheduleRollup(input.project, 1500);
    });

  return { eventId };
}

// In-flight distillation count per project (gates the rollup).
const inflight = new Map<string, number>();

async function distill(eventId: string, input: IngestInput): Promise<void> {
  if (!llmConfigured) {
    // No LLM configured: degrade gracefully — log a raw timeline entry so the
    // board still shows life, just without distillation.
    addTimeline(input.project, input.member, "did", input.text.slice(0, 200));
    bus.emitChange({ type: "timeline.added", project: input.project, member: input.member });
    return;
  }

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
    });
    setEventSignificance(eventId, sig);
  }
  // Rollup is scheduled by the settle-gate in ingest() once the queue drains.
}
