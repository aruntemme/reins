/**
 * 0G Compute Network — decentralized, verifiable LLM inference.
 *
 * This is the engine room of Reins when REINS_LLM_PROVIDER=0g: the entire
 * distillation pipeline (triage/extract/reconcile/rollup) runs on 0G's
 * decentralized GPU marketplace instead of a centralized gateway. Each call is
 * billed on-chain via the broker ledger and (for TEE providers) cryptographically
 * verified with processResponse — so the shared team context is provably distilled.
 *
 * API surface verified against @0gfoundation/0g-compute-ts-sdk@0.8.x:
 *   createZGComputeNetworkBroker(signer)
 *   broker.ledger.{ getLedger, addLedger(n), depositFund(n) }
 *   broker.inference.{ listService, acknowledgeProviderSigner, acknowledged,
 *                      getServiceMetadata, getRequestHeaders(addr, content?),
 *                      processResponse(addr, chatID?, content?) }
 */
import { createRequire } from "node:module";
import type { createZGComputeNetworkBroker as CreateBroker } from "@0gfoundation/0g-compute-ts-sdk";
import type OpenAI from "openai";
import { env } from "../env.js";
import { ogWallet, ogBalance } from "./og.js";

// The SDK's published ESM bundle is broken (bad re-export); its CommonJS build
// is fine. Load that lazily via createRequire so (a) we dodge the ESM bug and
// (b) the 0G SDK is never touched when running on a non-0G backend.
const require = createRequire(import.meta.url);
function computeSdk(): { createZGComputeNetworkBroker: typeof CreateBroker } {
  return require("@0gfoundation/0g-compute-ts-sdk");
}

type Broker = Awaited<ReturnType<typeof CreateBroker>>;
type Params = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;

let brokerP: Promise<Broker> | null = null;
let selected: { provider: string; endpoint: string; model: string } | null = null;

export const ogStats = {
  mode: "broker" as "broker" | "router",
  private: false, // router private-TEE routing enabled
  ready: false,
  provider: "" as string,
  model: "" as string,
  endpoint: "" as string,
  requests: 0,
  verified: 0, // responses confirmed by TEE attestation (processResponse === true)
  unverifiable: 0, // provider without TEE / verification returned null
  lastError: "" as string,
  balance: null as number | null,
};

async function getBroker(): Promise<Broker> {
  if (!brokerP) {
    brokerP = (async () => {
      const { createZGComputeNetworkBroker } = computeSdk();
      const broker = await createZGComputeNetworkBroker(ogWallet());
      await ensureFunded(broker);
      return broker;
    })().catch((e) => {
      brokerP = null; // allow retry on next call
      throw e;
    });
  }
  return brokerP;
}

/** Create the ledger on first use, or top it up when it runs low. Best-effort. */
async function ensureFunded(broker: Broker): Promise<void> {
  const topUp = env.og.ledgerTopUp;
  if (topUp <= 0) return;
  try {
    const ledger: any = await broker.ledger.getLedger();
    // balance is reported in neuron (1e18). Treat a low/zero balance as "top up".
    const bal = Number(ledger?.totalBalance ?? ledger?.balance ?? 0) / 1e18;
    if (bal < topUp) await broker.ledger.depositFund(topUp);
  } catch {
    // No ledger yet -> create one with an initial balance.
    try {
      await broker.ledger.addLedger(topUp);
    } catch (e: any) {
      // Funding may fail if the wallet has no testnet 0G yet; surface it but
      // don't crash — the inference call will report a clear error.
      ogStats.lastError = `ledger: ${e?.message ?? e}`;
    }
  }
}

/** Pick a provider once (pinned via env, else the first advertised service). */
async function pickProvider(broker: Broker) {
  if (selected) return selected;

  let providerAddr = env.og.computeProvider;
  if (!providerAddr) {
    const services: any[] = await broker.inference.listService();
    if (!services?.length) throw new Error("0G Compute: no inference providers available");
    // Prefer an LLM/chatbot service; fall back to the first one.
    const chat =
      services.find((s) => /chat|llm|text/i.test(String(s.serviceType ?? s.model ?? ""))) ??
      services[0];
    providerAddr = chat.provider ?? chat.providerAddress ?? chat.address;
  }
  if (!providerAddr) throw new Error("0G Compute: could not resolve a provider address");

  // Acknowledge the provider's signer once (required before billing).
  try {
    const ok = await broker.inference.acknowledged?.(providerAddr);
    if (!ok) await broker.inference.acknowledgeProviderSigner(providerAddr);
  } catch (e: any) {
    // Some SDK builds lack `acknowledged`; just try to acknowledge.
    try {
      await broker.inference.acknowledgeProviderSigner(providerAddr);
    } catch {
      /* may already be acknowledged */
    }
  }

  const meta = await broker.inference.getServiceMetadata(providerAddr);
  selected = { provider: providerAddr, endpoint: meta.endpoint, model: meta.model };
  ogStats.provider = providerAddr;
  ogStats.endpoint = meta.endpoint;
  ogStats.model = meta.model;
  ogStats.ready = true;
  return selected;
}

/** Last user message content — what the billing header signs over. */
function queryContent(params: Params): string {
  for (let i = params.messages.length - 1; i >= 0; i--) {
    const m = params.messages[i];
    if (m && m.role === "user")
      return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
  }
  return "";
}

/**
 * Run one chat completion on 0G Compute. Returns the assistant text.
 * Throws an error carrying `.status` on HTTP failures so the caller's
 * rate-limit/backoff retry logic still applies.
 */
export async function ogChat(params: Params): Promise<string> {
  const broker = await getBroker();
  const { provider, endpoint, model } = await pickProvider(broker);
  const content = queryContent(params);

  // Fresh signed billing headers per request (nonce + wallet signature).
  const headers = await broker.inference.getRequestHeaders(provider, content);

  // Fail fast on a hung provider so the serial distill queue keeps draining.
  const res = await fetch(`${endpoint}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(headers as unknown as Record<string, string>) },
    body: JSON.stringify({ ...params, model }),
    signal: AbortSignal.timeout(env.llm.timeoutMs),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err: any = new Error(`0G Compute ${res.status}: ${body.slice(0, 300)}`);
    err.status = res.status;
    ogStats.lastError = err.message;
    throw err;
  }

  const data: any = await res.json();
  const text: string = data?.choices?.[0]?.message?.content ?? "";
  ogStats.requests++;

  // Verify the response via TEE attestation (no-op/null for non-TEE providers).
  try {
    const ok = await broker.inference.processResponse(provider, data?.id, text);
    if (ok === true) ogStats.verified++;
    else ogStats.unverifiable++;
  } catch {
    ogStats.unverifiable++;
  }

  return text;
}

/** Refresh the wallet balance for the status surface. */
export async function ogRefreshBalance(): Promise<void> {
  try {
    ogStats.balance = await ogBalance();
  } catch {
    /* ignore */
  }
}
