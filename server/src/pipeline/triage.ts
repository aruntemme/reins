import { jsonComplete } from "../llm/client.js";
import { TriageSchema, type Triage } from "./schemas.js";

const SYSTEM = `You are the triage gate of Reins, a live team-context system.
Every event is a signal from a teammate's AI coding agent. Decide how much it matters
for a shared status board that a lead and peers read.

- "noise": ONLY truly contentless events (ran ls, read a file, "ok", formatting, empty/garbled).
- "minor": small but real progress, context, or status worth logging quietly.
- "major": clear intent, a decision, a blocker, a completed unit of work, or a new direction.

A teammate stating what they're working on, what they did, what they decided, or what's blocking
them is ALWAYS at least "minor" — those are exactly the signals this board exists to capture.
Reserve "noise" for events with no informational content. Classify the dominant "kind" too.
Respond ONLY as JSON: {"significance","kind","reason"}.`;

export async function triage(input: {
  kind: string;
  text: string;
  workspaceId?: string;
}): Promise<Triage> {
  return jsonComplete({
    schema: TriageSchema,
    system: SYSTEM,
    user: `EVENT KIND (hint): ${input.kind}\n\nEVENT TEXT:\n${input.text}`,
    fast: true,
    maxTokens: 1200,
    workspaceId: input.workspaceId,
  });
}
