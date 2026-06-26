import { z } from "zod";

export const TriageSchema = z.object({
  significance: z.enum(["noise", "minor", "major"]),
  kind: z.enum(["intent", "progress", "decision", "blocker", "done"]),
  reason: z.string().max(200),
});
export type Triage = z.infer<typeof TriageSchema>;

export const ExtractSchema = z.object({
  intent: z.string().describe("What the person is trying to accomplish right now, one sentence."),
  actions: z.array(z.string()).describe("Concrete things done since last update."),
  files: z.array(z.string()).describe("Files, modules, or areas touched."),
  decisions: z.array(z.string()).describe("Choices made worth remembering."),
  blockers: z.array(z.string()).describe("Things blocking progress."),
  next_steps: z.array(z.string()).describe("Stated or implied next steps / TODOs peers could pick up."),
});
export type Extract = z.infer<typeof ExtractSchema>;

// Reconcile emits an "operation set" — emulated tool calls that work on ANY
// OpenAI-compatible endpoint (no native function-calling required). Code applies them.
export const ReconcileSchema = z.object({
  headline: z.string().nullable().optional().describe("New 'doing right now' line, or null to leave unchanged."),
  goal: z.string().nullable().optional().describe("New session/task objective, or null."),
  status: z.enum(["active", "blocked", "idle"]).nullable().optional(),
  working_on: z.array(z.string()).nullable().optional().describe("Replace files/areas in play, or null."),
  timeline_add: z
    .array(z.object({ kind: z.enum(["did", "decided", "blocked", "started"]), summary: z.string() }))
    .default([])
    .describe("NEW concrete events only — never restate the headline."),
  pending_add: z.array(z.string()).default([]).describe("New pending/next items a peer could pick up."),
  pending_resolve: z.array(z.string()).default([]).describe("Ids of existing pending items now done."),
});
export type Reconcile = z.infer<typeof ReconcileSchema>;

// Combined single-call distillation: triage + extract + reconcile in one shot.
// One LLM call per event — robust on rate-limited / reasoning endpoints.
export const DistillSchema = z.object({
  significance: z.enum(["noise", "minor", "major"]).describe("noise = skip; otherwise apply ops."),
  headline: z.string().nullable().optional(),
  goal: z.string().nullable().optional(),
  status: z.enum(["active", "blocked", "idle"]).nullable().optional(),
  working_on: z.array(z.string()).nullable().optional(),
  timeline_add: z
    .array(z.object({ kind: z.enum(["did", "decided", "blocked", "started"]), summary: z.string() }))
    .default([]),
  pending_add: z.array(z.string()).default([]),
  pending_resolve: z.array(z.string()).default([]),
  mentions: z
    .array(z.object({ to: z.string(), note: z.string() }))
    .default([])
    .describe("Teammates this person directly flagged/@mentioned/handed work to, with what they need. 'to' MUST be an exact name from the provided ROSTER."),
  goal_ops: z
    .array(
      z.object({
        op: z.enum(["check_item", "add_item", "block_goal"]),
        itemId: z.string().optional().describe("for check_item: the exact OPEN GOAL ITEM id this event completed"),
        goalId: z.string().optional().describe("for add_item / block_goal: the exact GOAL id"),
        text: z.string().optional().describe("for add_item: the new sub-task text"),
        reason: z.string().describe("one short sentence: why this event implies it"),
      })
    )
    .default([])
    .describe(
      "PROPOSED, NOT applied. Only when the event CLEARLY shows it: check_item when an OPEN GOAL ITEM is now demonstrably done; add_item when the work is a concrete sub-task of a listed goal that isn't already an item; block_goal when the person is clearly blocked on that goal. Use only the exact ids provided. Empty array if unsure."
    ),
});
export type Distill = z.infer<typeof DistillSchema>;

export const RollupSchema = z.object({
  summary: z.string().describe("2-4 sentence status of the whole project right now."),
  alignment: z.string().describe("How current work tracks against the stated project goal."),
  collisions: z
    .array(z.object({ area: z.string(), members: z.array(z.string()), note: z.string() }))
    .describe("Same file/area touched by multiple people."),
  risks: z.array(z.string()).describe("Risks, stalls, or gaps a lead should know."),
  handoffs: z
    .array(
      z.object({
        to: z.string().describe("Exact teammate name (from roster) who should act."),
        from: z.string().describe("Teammate name the signal came from, or '' for the team."),
        kind: z.enum(["collision", "blocker", "fyi"]),
        reason: z.string().describe("What they should do / coordinate, one line."),
      })
    )
    .default([])
    .describe("Directed nudges: who needs to coordinate, unblock, or be aware. e.g. two people editing one file -> a collision handoff to each."),
});
export type Rollup = z.infer<typeof RollupSchema>;
