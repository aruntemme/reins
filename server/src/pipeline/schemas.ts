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
    .describe("ONLY teammates this person EXPLICITLY addressed by name in the event (heads-up / handed work / blocked on theirs). NOT instructions to their own agent, status notes, or names dropped in passing. The teammate's name must appear in the event. 'to' MUST be an exact name from the provided ROSTER. [] if none."),
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
  trait_ops: z
    .array(
      // Deliberately PERMISSIVE per element: the model improvises shapes, and a
      // zod array fails wholesale on one bad element — which would silently drop
      // every trait. So we accept loosely here and enforce semantics (valid op,
      // length caps, required fields) in applyTraitOps, where a single bad op is
      // skipped without taking the others (or the rest of the distill) down.
      z.object({
        // op may be a value ("add") or — as some models emit — the wrapping key
        // ({"add": {...}}); both are normalized in applyTraitOps, so keep it loose.
        op: z.string().optional().describe("reinforce | revise | add"),
        traitId: z.string().optional().describe("for reinforce/revise: the exact id from MY TASTE PROFILE below"),
        type: z.string().optional().describe(
          "for add/revise, one of: tooling=langs/libs/tools they reach for; quality=their bar for correctness/tests/polish; communication=how they phrase/plan; concern=what they repeatedly care about (security/perf/cost/UX); workflow=how they decompose & drive work"
        ),
        statement: z.string().optional().describe("for add/revise: the DURABLE, ABSTRACT preference, e.g. 'prefers terse single-purpose functions'. Never task-specific."),
        evidence: z.string().optional().default("").describe("one short PARAPHRASE of why — NEVER the raw prompt, no code, secrets, file paths, or identifiers"),
      }).passthrough()
    )
    .catch([]) // last-resort net: a wholly malformed trait_ops must never sink the distill
    .default([])
    .describe(
      "The person's durable WORKING GRAIN (taste), learned over time — NOT what they did this once. Be conservative: prefer 'reinforce' an existing trait over inventing one; only 'add' when a clear, repeatable preference shows that isn't already listed. Empty array for routine activity. This is a privacy-sensitive abstraction: emit preferences, never content."
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
