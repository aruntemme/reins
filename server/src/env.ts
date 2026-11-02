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

function trustProxy(v: string): boolean | number | string {
  if (!v || /^(off|false|0)$/i.test(v)) return false;
  if (/^(on|true)$/i.test(v)) return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v; // e.g. "loopback" or a comma-separated list of addresses/subnets
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
  // Express "trust proxy": which X-Forwarded-For hops to believe for req.ip (the
  // key for login/signup abuse limits). Off by default — a direct-to-internet
  // server must not trust a spoofable header. Behind proxies, set the hop count
  // (e.g. 2 for Vercel rewrite -> Caddy -> server) or "loopback" etc.
  trustProxy: trustProxy(str("REINS_TRUST_PROXY")),

  // Raw captured event text older than this many days is blanked by the hourly
  // cleanup (distilled state is kept). 0 = keep raw text forever.
  eventRetentionDays: num("REINS_EVENT_RETENTION_DAYS", 30),

  // How long a `reins-hook` device login (POST /api/cli/login) stays approvable
  // and pollable. 10 minutes; overridable only so tests can expire one quickly.
  cliLoginTtlMs: Math.max(1000, num("REINS_CLI_LOGIN_TTL_MS", 10 * 60_000)),

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
