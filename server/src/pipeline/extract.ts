import { jsonComplete } from "../llm/client.js";
import { ExtractSchema, type Extract } from "./schemas.js";

const SYSTEM = `You are the extraction stage of Reins. Turn one raw agent event into clean,
structured facts for a shared team-context board. Be faithful to the text — do not invent.
Prefer empty arrays over speculation. Keep each item short and concrete (no fluff).
Respond ONLY as JSON matching: {intent, actions[], files[], decisions[], blockers[], next_steps[]}.`;

export async function extract(input: {
  member: string;
  text: string;
  projectGoal: string;
}): Promise<Extract> {
  const goal = input.projectGoal
    ? `\n\nPROJECT GOAL (for relevance only): ${input.projectGoal}`
    : "";
  return jsonComplete({
    schema: ExtractSchema,
    system: SYSTEM,
    user: `TEAMMATE: ${input.member}${goal}\n\nEVENT:\n${input.text}`,
    maxTokens: 2500,
  });
}
