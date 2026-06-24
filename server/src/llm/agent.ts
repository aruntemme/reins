import OpenAI from "openai";
import { env } from "../env.js";
import { llm } from "./client.js";

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  run: (args: any) => string | Promise<string>; // returns a short result string
}

export interface AgentResult {
  toolCalls: { name: string; args: any }[];
  finalText: string;
}

/**
 * Minimal, robust tool-calling loop over the OpenAI-compatible chat API.
 * The model calls tools (which execute real side effects) until it stops.
 */
export async function runToolAgent(opts: {
  system: string;
  user: string;
  tools: Tool[];
  model?: string;
  maxSteps?: number;
}): Promise<AgentResult> {
  const model = opts.model ?? env.llm.model;
  const maxSteps = opts.maxSteps ?? 8;
  const toolMap = new Map(opts.tools.map((t) => [t.name, t]));
  const toolDefs = opts.tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  const messages: Msg[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.user },
  ];
  const executed: { name: string; args: any }[] = [];

  for (let step = 0; step < maxSteps; step++) {
    const res = await llm.chat.completions.create({
      model,
      max_tokens: env.llm.maxTokens,
      messages,
      tools: toolDefs,
      tool_choice: "auto",
    });

    const choice = res.choices[0]?.message;
    if (!choice) break;
    messages.push(choice as Msg);

    const calls = choice.tool_calls ?? [];
    if (calls.length === 0) {
      return { toolCalls: executed, finalText: choice.content ?? "" };
    }

    for (const call of calls) {
      if (call.type !== "function") continue;
      const tool = toolMap.get(call.function.name);
      let result: string;
      let args: any = {};
      if (!tool) {
        result = `error: unknown tool ${call.function.name}`;
      } else {
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          args = {};
        }
        try {
          result = await tool.run(args);
          executed.push({ name: tool.name, args });
        } catch (err) {
          result = `error: ${(err as Error).message}`;
        }
      }
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result,
      });
    }
  }

  return { toolCalls: executed, finalText: "" };
}
