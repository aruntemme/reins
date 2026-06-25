import { existsSync, readFileSync } from "node:fs";
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

  // Which inference backend powers the distillation pipeline.
  //   "openai"    -> any OpenAI-compatible gateway (REINS_LLM_* below)
  //   "0g-router" -> 0G Private Computer Router (pc.0g.ai) — OpenAI-compatible,
  //                  on-chain billed, cryptographically attested. RECOMMENDED.
  //   "0g"        -> 0G Compute broker SDK (advanced: wallet signs each request)
  llmProvider: str("REINS_LLM_PROVIDER", "openai").toLowerCase(),

  llm: {
    baseURL: str("REINS_LLM_BASE_URL", "https://api.openai.com/v1"),
    apiKey: str("REINS_LLM_API_KEY"),
    model: str("REINS_LLM_MODEL", "gpt-4o"),
    fastModel: str("REINS_LLM_MODEL_FAST") || str("REINS_LLM_MODEL", "gpt-4o"),
    maxTokens: num("REINS_LLM_MAX_TOKENS", 2000),
  },

  // 0G — decentralized AI compute + storage. The chain wallet (a throwaway
  // testnet key) signs inference billing and storage uploads. Key resolves
  // from OG_PRIVATE_KEY, else the gitignored ./.0g-key file.
  og: {
    // 0G Private Computer Router (OpenAI-compatible front door to 0G Compute).
    // Key + deposit are managed in the pc.0g.ai dashboard; the server just needs
    // the API key. Testnet default; override for mainnet (router-api.0g.ai/v1).
    routerBaseUrl: str("OG_ROUTER_BASE_URL", "https://router-api-testnet.integratenetwork.work/v1"),
    routerApiKey: str("OG_ROUTER_API_KEY"),
    // Route inference to privacy-enabled TEE providers (sealed enclaves).
    privateMode: str("OG_PRIVATE", "off").toLowerCase() === "on",
    // Cap output tokens to the model's max (e.g. qwen2.5-omni = 2048) so the
    // router doesn't reject calls that ask for more.
    maxOutput: num("OG_MAX_OUTPUT", 2048),

    rpcUrl: str("OG_RPC_URL", "https://evmrpc-testnet.0g.ai"),
    privateKey: ogKey(),
    // Pin a specific 0G Compute provider address; else we auto-pick one.
    computeProvider: str("OG_COMPUTE_PROVIDER"),
    // Top up the broker ledger to this many 0G when it runs low (0 = never).
    ledgerTopUp: num("OG_LEDGER_TOPUP", 1),
    // Decentralized storage for verifiable context snapshots.
    storageEnabled: str("OG_STORAGE", "off").toLowerCase() === "on",
    storageIndexer: str("OG_STORAGE_INDEXER", "https://indexer-storage-testnet-turbo.0g.ai"),
    storageRpc: str("OG_STORAGE_RPC") || str("OG_RPC_URL", "https://evmrpc-testnet.0g.ai"),
    explorer: str("OG_EXPLORER", "https://chainscan-galileo.0g.ai"),
    storageExplorer: str("OG_STORAGE_EXPLORER", "https://storagescan-galileo.0g.ai"),
  },

  // Outbound notification webhooks. When a rollup is synthesized we post a
  // concise digest to whichever of these is configured. Empty = disabled.
  integrations: {
    slackWebhook: str("REINS_SLACK_WEBHOOK"),
    discordWebhook: str("REINS_DISCORD_WEBHOOK"),
  },
};

function ogKey(): string {
  const fromEnv = process.env.OG_PRIVATE_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    const p = resolve(process.cwd(), ".0g-key");
    if (existsSync(p)) return readFileSync(p, "utf8").trim();
  } catch {
    /* ignore */
  }
  return "";
}

export const usesRouter = env.llmProvider === "0g-router";
export const usesOG = env.llmProvider === "0g"; // broker SDK (advanced)
export const ogConfigured = Boolean(env.og.privateKey);
// The pipeline is "configured" if its chosen backend has what it needs.
export const llmConfigured = usesRouter
  ? Boolean(env.og.routerApiKey)
  : usesOG
    ? ogConfigured
    : Boolean(env.llm.apiKey);
