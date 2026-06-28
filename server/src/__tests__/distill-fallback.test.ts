import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Configure a REAL but unreachable OpenAI-compatible backend BEFORE importing any
// module that reads env at load time. No stubs: the OpenAI client genuinely tries
// to connect to 127.0.0.1:1 and fails, which is exactly what a provider outage
// (402 Insufficient balance / connection refused) looks like to distill().
process.env.REINS_DB = join(tmpdir(), `reins-fallback-${randomUUID()}.db`);
process.env.REINS_LLM_PROVIDER = "openai";
process.env.REINS_LLM_API_KEY = "test-key-present-so-llmConfigured-is-true";
process.env.REINS_LLM_BASE_URL = "http://127.0.0.1:1/v1"; // nothing listens here
process.env.REINS_PIPELINE_MODE = "combined";

const db = await import("../db.js");
const { ingest } = await import("../pipeline/index.js");

// Poll the timeline until an entry shows up (distill runs async on a serial
// queue) or we time out. The connection failure is non-retriable, so this
// resolves quickly in practice.
async function waitForTimeline(project: string, member: string, timeoutMs = 8000): Promise<any[]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rows = db.recentTimeline(project, member, 10);
    if (rows.length) return rows;
    await new Promise((r) => setTimeout(r, 100));
  }
  return db.recentTimeline(project, member, 10);
}

test("a substantive event still reaches the timeline when the LLM provider is down", async () => {
  db.ensureProject("fb", "Fallback", "w1");
  db.ensureMember("fb", "arun", "Arun");

  const text = "Refactored the auth middleware to validate session cookies before hitting the DB";
  await ingest({ project: "fb", member: "arun", kind: "progress", text });

  const rows = await waitForTimeline("fb", "arun");
  assert.equal(rows.length >= 1, true, "provider outage must degrade to a raw timeline entry, not a blank board");
  assert.equal(rows[0].summary.startsWith("Refactored the auth middleware"), true, "raw capture preserves the event text");
});

test("trivial captures are not flooded onto the board during an outage", async () => {
  db.ensureProject("fb2", "Fallback2", "w1");
  db.ensureMember("fb2", "arun", "Arun");

  await ingest({ project: "fb2", member: "arun", kind: "progress", text: "ok" });

  // Give the async distill the same window it had above; it should choose to add
  // nothing because the text is below the raw-fallback threshold.
  await new Promise((r) => setTimeout(r, 1500));
  const rows = db.recentTimeline("fb2", "arun", 10);
  assert.equal(rows.length, 0, "sub-threshold text must be skipped, not dumped raw");
});
