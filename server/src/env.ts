import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Load .env if present (Node 22+ native loader). Real env vars still win.
const envPath = resolve(process.cwd(), ".env");
if (existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
  } catch {
    /* ignore malformed .env */
  }
}

function str(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}
function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

export const env = {
  port: num("PORT", 4319),
  dbPath: str("REINS_DB", "./reins.db"),
  ingestKey: str("REINS_INGEST_KEY"),

  // Multi-tenant auth. Off by default (single open instance for local dev);
  // turn on for any shared/deployed instance.
  authEnabled: str("REINS_AUTH", "off").toLowerCase() === "on",
  sessionSecret: str("REINS_SESSION_SECRET"),
  cookieSecure: str("REINS_COOKIE_SECURE", "auto"), // auto | on | off

  // Fallback inference backend (any OpenAI-compatible gateway). Used only when no
  // provider has been configured in the dashboard (DB). The active dashboard
  // provider, if any, overrides every field here at request time.
  llm: {
    baseURL: str("REINS_LLM_BASE_URL", "https://api.openai.com/v1"),
    apiKey: str("REINS_LLM_API_KEY"),
    model: str("REINS_LLM_MODEL", "gpt-4o"),
    fastModel: str("REINS_LLM_MODEL_FAST") || str("REINS_LLM_MODEL", "gpt-4o"),
    maxTokens: num("REINS_LLM_MAX_TOKENS", 2000),
    // Hard ceiling per request. A hung gateway (no response, no error) would
    // otherwise wedge the serial distill queue forever; this turns a hang into a
    // fast failure so the queue drains. Generous, since reasoning models legitimately
    // take ~2 min. Tune via REINS_LLM_TIMEOUT_MS.
    timeoutMs: num("REINS_LLM_TIMEOUT_MS", 180000),
  },

  // Outbound notification webhooks. When a rollup is synthesized we post a
  // concise digest to whichever of these is configured. Empty = disabled.
  integrations: {
    slackWebhook: str("REINS_SLACK_WEBHOOK"),
    discordWebhook: str("REINS_DISCORD_WEBHOOK"),
  },
};

// Whether the env-level fallback backend has an API key. The real "is the
// pipeline configured?" check also considers DB providers — see llm/client.ts.
export const envLlmConfigured = Boolean(env.llm.apiKey);
