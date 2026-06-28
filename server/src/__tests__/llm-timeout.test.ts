import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// A real HTTP server that accepts the request and then NEVER responds — exactly
// the hung-gateway failure that wedged the serial distill queue.
function hangingServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(() => { /* hold the socket open, send nothing */ });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0 });
    });
  });
}

const { server, port } = await hangingServer();

// Point the LLM client at the hung server with a short timeout BEFORE importing it.
process.env.REINS_DB = join(tmpdir(), `reins-timeout-${randomUUID()}.db`);
process.env.REINS_LLM_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.REINS_LLM_API_KEY = "test-key";
process.env.REINS_LLM_MODEL = "test-model";
process.env.REINS_LLM_TIMEOUT_MS = "600";

const { chat } = await import("../llm/client.js");

test("a hung gateway makes chat() fail fast (not hang the queue forever)", async () => {
  const t0 = Date.now();
  await assert.rejects(
    () => chat({ model: "test-model", max_tokens: 10, messages: [{ role: "user", content: "hi" }] } as any),
    "a non-responding gateway must reject, not hang"
  );
  const elapsed = Date.now() - t0;
  // 600ms timeout, no retry on a timeout (no status code) → should be well under 5s.
  assert.ok(elapsed < 5000, `chat() returned in ${elapsed}ms — timed out fast instead of hanging`);
});

test.after(() => server.close());
