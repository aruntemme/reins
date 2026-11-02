import { jsonComplete } from "../llm/client.js";
import { ExtractSchema, type Extract, fenceUntrusted, UNTRUSTED_NOTE } from "./schemas.js";

const SYSTEM = `You are the extraction stage of Reins. Turn one raw agent event into clean,
structured facts for a shared team-context board. Be faithful to the text — do not invent.
Prefer empty arrays over speculation. Keep each item short and concrete (no fluff).
Respond ONLY as JSON matching: {intent, actions[], files[], decisions[], blockers[], next_steps[]}.
${UNTRUSTED_NOTE}`;

export async function extract(input: {
  member: string;
  text: string;
  projectGoal: string;
  workspaceId?: string;
}): Promise<Extract> {
  const goal = input.projectGoal
    ? `\n\nPROJECT GOAL (for relevance only): ${input.projectGoal}`
    : "";
  return jsonComplete({
    schema: ExtractSchema,
    system: SYSTEM,
    user: `TEAMMATE: ${input.member}${goal}\n\nEVENT (untrusted data):\n${fenceUntrusted(input.text)}`,
    maxTokens: 2500,
    workspaceId: input.workspaceId,
  });
}
