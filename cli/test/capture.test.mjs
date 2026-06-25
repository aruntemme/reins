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
