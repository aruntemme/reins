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

  llm: {
    baseURL: str("REINS_LLM_BASE_URL", "https://api.openai.com/v1"),
    apiKey: str("REINS_LLM_API_KEY"),
    model: str("REINS_LLM_MODEL", "gpt-4o"),
    fastModel: str("REINS_LLM_MODEL_FAST") || str("REINS_LLM_MODEL", "gpt-4o"),
    maxTokens: num("REINS_LLM_MAX_TOKENS", 2000),
  },
};

export const llmConfigured = Boolean(env.llm.apiKey);
