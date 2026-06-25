import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { sendEvent } from "../lib/capture.mjs";
import { mapGeneric } from "../adapters/generic.mjs";
import { mapCodex } from "../adapters/codex.mjs";
import { mapOpencode } from "../adapters/opencode.mjs";
import { mapAider, lastAiderAssistant } from "../adapters/aider.mjs";
import { pick } from "../adapters/_shared.mjs";

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

// ---- pure mapping: generic ----

test("mapGeneric resolves text from default fields and defaults kind", () => {
  assert.deepEqual(mapGeneric({ prompt: "add auth" }), { kind: "progress", text: "add auth" });
  assert.deepEqual(mapGeneric({ message: "shipped" }), { kind: "progress", text: "shipped" });
});

test("mapGeneric honors explicit text/kind and validates kind", () => {
  assert.deepEqual(mapGeneric({ prompt: "ignored" }, { text: "real", kind: "intent" }), {
    kind: "intent",
    text: "real",
  });
  // bogus kind falls back to progress
  assert.equal(mapGeneric({ text: "x" }, { kind: "nonsense" }).kind, "progress");
  // kind can ride in the payload
  assert.equal(mapGeneric({ text: "x", kind: "summary" }).kind, "summary");
});

test("mapGeneric supports configurable dot-path text fields", () => {
  const payload = { input: { text: "nested prompt" } };
  assert.equal(mapGeneric(payload, { textFields: ["input.text"] }).text, "nested prompt");
});

test("mapGeneric yields empty text when nothing matches", () => {
  assert.deepEqual(mapGeneric({ unrelated: 1 }), { kind: "progress", text: "" });
});

// ---- pure mapping: codex ----

test("mapCodex maps agent-turn-complete to a summary of the answer", () => {
  const r = mapCodex({
    type: "agent-turn-complete",
    "turn-id": "t1",
    "input-messages": ["refactor the parser"],
    "last-assistant-message": "Refactored parser into modules.",
  });
  assert.deepEqual(r, { kind: "summary", text: "Refactored parser into modules." });
});

test("mapCodex falls back to the prompt as intent when no answer yet", () => {
  const r = mapCodex({ type: "agent-turn-complete", "input-messages": ["do the thing"] });
  assert.deepEqual(r, { kind: "intent", text: "do the thing" });
});

test("mapCodex joins multiple input messages", () => {
  const r = mapCodex({ type: "agent-turn-complete", "input-messages": ["a", "b"] });
  assert.equal(r.text, "a\nb");
});

// ---- pure mapping: opencode ----

test("mapOpencode maps a user message to intent", () => {
  const r = mapOpencode({ type: "message.sent", properties: { role: "user", text: "fix the bug" } });
  assert.deepEqual(r, { kind: "intent", text: "fix the bug" });
});

test("mapOpencode maps an idle/assistant turn to summary", () => {
  const r = mapOpencode({ type: "session.idle", properties: { role: "assistant", text: "Fixed it." } });
  assert.deepEqual(r, { kind: "summary", text: "Fixed it." });
});

test("mapOpencode accepts a flat message object", () => {
  assert.deepEqual(mapOpencode({ role: "user", text: "hello" }), { kind: "intent", text: "hello" });
});

// ---- pure mapping: aider ----

test("mapAider maps an assistant/response payload to summary", () => {
  assert.deepEqual(mapAider({ response: "Added tests." }), { kind: "summary", text: "Added tests." });
  assert.deepEqual(mapAider({ assistant: "Done." }), { kind: "summary", text: "Done." });
});

test("mapAider maps a prompt-only payload to intent", () => {
  assert.deepEqual(mapAider({ prompt: "write a test" }), { kind: "intent", text: "write a test" });
});

test("lastAiderAssistant extracts the last assistant turn from history md", () => {
  const md = [
    "#### add a function",
    "",
    "Sure, here you go.",
    "",
    "#### now test it",
    "",
    "Added a passing test.",
    "",
  ].join("\n");
  assert.equal(lastAiderAssistant(md), "Added a passing test.");
});

// ---- shared pick helper ----

test("pick returns the first non-empty match and skips blanks", () => {
  assert.equal(pick({ a: "  ", b: "real" }, ["a", "b"]), "real");
  assert.equal(pick({ n: 42 }, ["n"]), "42");
  assert.equal(pick({}, ["a", "b"]), "");
});

// ---- end-to-end over a real local HTTP server ----

test("generic adapter end-to-end carries the configured source and fields", async () => {
  const s = await captureServer();
  try {
    const { kind, text } = mapGeneric({ prompt: "deploy it" }, { kind: "intent" });
    const r = await sendEvent({
      url: s.url,
      project: "demo",
      member: "asha",
      kind,
      text,
      source: "my-bot",
    });
    assert.equal(r.ok, true);
    const got = s.get();
    assert.equal(got.body.source, "my-bot");
    assert.equal(got.body.meta.source, "my-bot");
    assert.equal(got.body.kind, "intent");
    assert.equal(got.body.text, "deploy it");
  } finally {
    s.close();
  }
});

test("codex adapter end-to-end carries source=codex", async () => {
  const s = await captureServer();
  try {
    const { kind, text } = mapCodex({
      type: "agent-turn-complete",
      "last-assistant-message": "Shipped the feature.",
    });
    const r = await sendEvent({ url: s.url, project: "demo", member: "rui", kind, text, source: "codex" });
    assert.equal(r.ok, true);
    const got = s.get();
    assert.equal(got.body.source, "codex");
    assert.equal(got.body.kind, "summary");
    assert.equal(got.body.text, "Shipped the feature.");
  } finally {
    s.close();
  }
});
