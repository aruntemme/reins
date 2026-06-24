import OpenAI from "openai";
import { z } from "zod";
import { env, llmConfigured } from "../env.js";

export const llm = new OpenAI({
  baseURL: env.llm.baseURL,
  apiKey: env.llm.apiKey || "not-set",
  maxRetries: 0, // we handle retry/backoff ourselves (below)
});

export { llmConfigured };

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type Params = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;

// ── Serial queue + rate-limit-aware retry ─────────────────────
// Many OpenAI-compatible gateways (and reasoning models) throttle hard. We
// serialize requests with a small gap and retry on 429/5xx, honoring the
// server's suggested delay ("Retry in 14s" / Retry-After header).
let chain: Promise<unknown> = Promise.resolve();
const GAP_MS = 350;

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn) as Promise<T>;
  chain = run.then(
    () => sleep(GAP_MS),
    () => sleep(GAP_MS)
  );
  return run;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function retryDelayMs(err: any, attempt: number): number {
  const ra = Number(err?.headers?.["retry-after"]);
  if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000, 30000);
  const m = String(err?.message || "").match(/retry in\s+(\d+)\s*s/i);
  if (m) return Math.min(Number(m[1]) * 1000 + 500, 30000);
  return Math.min(1500 * 2 ** attempt, 20000); // exponential fallback
}

export async function chat(params: Params, attempts = 8): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await enqueue(() => llm.chat.completions.create(params));
      return res.choices[0]?.message?.content ?? "";
    } catch (err: any) {
      lastErr = err;
      const status = err?.status ?? err?.response?.status;
      const retriable = status === 429 || status === 408 || (status >= 500 && status < 600);
      if (!retriable || attempt === attempts - 1) break;
      const wait = retryDelayMs(err, attempt);
      console.error(`[llm] ${status} — retry ${attempt + 1}/${attempts} in ${wait}ms`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

/** Pull the first balanced JSON object out of a string (reasoning models wrap it in prose/fences). */
function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf("{");
  if (start === -1) return body.trim();
  let depth = 0;
  for (let i = start; i < body.length; i++) {
    const c = body[i];
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return body.slice(start, i + 1);
  }
  return body.slice(start).trim();
}

/**
 * Get a schema-validated JSON object from the model. Provider-agnostic:
 * tries native json_object mode, falls back to plain parsing, and does one
 * self-repair retry if validation fails.
 */
export async function jsonComplete<T>(opts: {
  schema: z.ZodType<T>;
  system: string;
  user: string;
  model?: string;
  maxTokens?: number;
}): Promise<T> {
  const model = opts.model ?? env.llm.model;
  const max_tokens = opts.maxTokens ?? env.llm.maxTokens;
  const messages: Msg[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.user },
  ];

  let raw: string;
  try {
    raw = await chat({ model, max_tokens, messages, response_format: { type: "json_object" } as any });
  } catch {
    // Some providers reject response_format — retry without it.
    raw = await chat({ model, max_tokens, messages });
  }

  const first = opts.schema.safeParse(safeParse(raw));
  if (first.success) return first.data;

  // One repair pass.
  const repaired = await chat({
    model,
    max_tokens,
    response_format: { type: "json_object" } as any,
    messages: [
      ...messages,
      { role: "assistant", content: raw },
      {
        role: "user",
        content: `That did not match the required schema (${first.error.issues
          .map((i) => i.path.join(".") + ": " + i.message)
          .join("; ")}). Reply with ONLY the corrected JSON object.`,
      },
    ],
  });
  return opts.schema.parse(safeParse(repaired));
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON.parse(extractJson(raw));
    } catch {
      return {};
    }
  }
}
