import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { sendEvent } from "../lib/capture.mjs";
import { mapClaudeHook } from "../reins-hook.mjs";

/** Spin a throwaway HTTP server that records the next POST /api/ingest body. */
async function captureServer() {
  let received = null;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received = { url: req.url, body: JSON.parse(body || "{}"), headers: req.headers };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, eventId: "test" }));
    });
  });
  server.listen(0);
  await once(server, "listening");
  const port = server.address().port;
  return { url: `http://localhost:${port}`, get: () => received, close: () => server.close() };
}

test("sendEvent posts a well-formed event carrying the source", async () => {
  const s = await captureServer();
  try {
    const r = await sendEvent({
      url: s.url,
      project: "demo",
      member: "asha",
      kind: "intent",
      text: "build the thing",
      source: "codex",
      key: "secret",
    });
    assert.equal(r.ok, true);
    const got = s.get();
    assert.equal(got.url, "/api/ingest");
    assert.equal(got.body.project, "demo");
    assert.equal(got.body.member, "asha");
    assert.equal(got.body.kind, "intent");
    assert.equal(got.body.text, "build the thing");
    assert.equal(got.body.source, "codex");
    assert.equal(got.body.meta.source, "codex");
    assert.equal(got.headers["x-reins-key"], "secret");
  } finally {
    s.close();
  }
});

test("sendEvent defaults source to claude-code", async () => {
  const s = await captureServer();
  try {
    await sendEvent({ url: s.url, project: "demo", member: "x", text: "hi" });
    assert.equal(s.get().body.source, "claude-code");
    assert.equal(s.get().body.kind, "progress");
  } finally {
    s.close();
  }
});

test("sendEvent skips empty text without hitting the network", async () => {
  const r = await sendEvent({ url: "http://127.0.0.1:1", project: "p", member: "m", text: "   " });
  assert.deepEqual(r, { ok: false, skipped: true });
});

test("sendEvent reports unreachable instead of throwing", async () => {
  // Reserved TEST-NET-1 address / closed port -> connection fails fast.
  const r = await sendEvent({ url: "http://127.0.0.1:1", project: "p", member: "m", text: "hi", timeoutMs: 300 });
  assert.equal(r.ok, false);
  assert.equal(r.unreachable, true);
});

test("mapClaudeHook maps Claude Code events to kinds", () => {
  assert.deepEqual(mapClaudeHook({ hook_event_name: "UserPromptSubmit", prompt: "do x" }), {
    kind: "intent",
    text: "do x",
  });
  const stop = mapClaudeHook({ hook_event_name: "Stop", transcript_path: "/nope/missing.jsonl" });
  assert.equal(stop.kind, "summary"); // text empty when transcript missing, but kind correct
});

test("sendEventDetached returns at once and the detached child still delivers", async () => {
  const { sendEventDetached } = await import("../lib/capture.mjs");
  // A server that answers slowly — the caller must not wait for it.
  let received = null;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received = JSON.parse(body || "{}");
      setTimeout(() => { res.writeHead(200); res.end("{}"); }, 1500);
    });
  });
  server.listen(0);
  await once(server, "listening");
  try {
    const t0 = Date.now();
    const ok = sendEventDetached({
      url: `http://127.0.0.1:${server.address().port}`,
      project: "demo", member: "asha", kind: "intent",
      text: "ship it with key sk-proj-ABCDEFGHIJKLMNOPQRST1234",
    });
    assert.equal(ok, true);
    assert.ok(Date.now() - t0 < 500, "returned without waiting on the network");
    const deadline = Date.now() + 8000;
    while (!received && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.ok(received, "the child posted the event");
    assert.equal(received.project, "demo");
    assert.ok(!received.text.includes("ABCDEFGHIJKLMNOPQRST1234"), "redacted before it left the parent");
  } finally {
    server.close();
  }
});

test("lastAssistantText reads the tail and skips a corrupt line", async () => {
  const { lastAssistantText } = await import("../lib/capture.mjs");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "reins-tx-"));
  const p = join(dir, "t.jsonl");
  const filler = JSON.stringify({ message: { role: "user", content: "x".repeat(4000) } });
  const lines = [];
  for (let i = 0; i < 400; i++) lines.push(filler); // ~1.6MB: larger than the tail window
  lines.push(JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "final answer" }] } }));
  lines.push("{ this is not json");
  writeFileSync(p, lines.join("\n") + "\n");
  assert.equal(lastAssistantText(p), "final answer");
  assert.equal(lastAssistantText(join(dir, "missing.jsonl")), "");
});
