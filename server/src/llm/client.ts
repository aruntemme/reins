import OpenAI from "openai";
import { z } from "zod";
import { env, llmConfigured, usesOG, usesRouter } from "../env.js";
import { ogChat, ogStats } from "./og-compute.js";

export const llm = new OpenAI({
  baseURL: env.llm.baseURL,
  apiKey: env.llm.apiKey || "not-set",
  maxRetries: 0, // we handle retry/backoff ourselves (below)
  timeout: env.llm.timeoutMs, // fail fast on a hung gateway so the queue keeps draining
});

// 0G Private Computer Router — OpenAI-compatible, so it's just a client pointed
// at the router with the pc.0g.ai API key. Optional private-TEE routing header.
const router = usesRouter
  ? new OpenAI({
      baseURL: env.og.routerBaseUrl,
      apiKey: env.og.routerApiKey || "not-set",
      maxRetries: 0,
      timeout: env.llm.timeoutMs,
      defaultHeaders: env.og.privateMode ? { "X-0G-Provider-Trust-Mode": "private" } : undefined,
    })
  : null;

if (usesRouter) {
  ogStats.mode = "router";
  ogStats.ready = true;
  ogStats.model = env.llm.model;
  ogStats.endpoint = env.og.routerBaseUrl;
  ogStats.private = env.og.privateMode;
}

export { llmConfigured };

/**
 * One raw completion against the configured backend — 0G Router (recommended),
 * the 0G broker SDK, or any OpenAI-compatible gateway. Same signature either
 * way, so the serial queue + backoff below is backend-agnostic.
 */
async function rawCompletion(params: Params): Promise<string> {
  if (usesRouter && router) {
    // Respect the model's output cap (e.g. qwen2.5-omni maxes at 2048).
    const cap = env.og.maxOutput;
    const max_tokens = Math.min(params.max_tokens ?? cap, cap);
    const res = await router.chat.completions.create({ ...params, max_tokens });
    ogStats.requests++;
    return res.choices[0]?.message?.content ?? "";
  }
  if (usesOG) return ogChat(params);
  const res = await llm.chat.completions.create(params);
  return res.choices[0]?.message?.content ?? "";
}

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
      return await enqueue(() => rawCompletion(params));
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
