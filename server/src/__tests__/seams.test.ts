import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Isolate the DB on a fresh temp file BEFORE importing anything that opens it.
process.env.REINS_DB = join(tmpdir(), `reins-seams-${randomUUID()}.db`);
// Pin the encryption key so the provider tests never auto-generate a .reins-secret file.
process.env.REINS_SECRET_KEY = "test-master-key-for-seams-provider-encryption";

const db = await import("../db.js");

test("source attribution: insertEvent persists an explicit source", () => {
  db.ensureProject("p1", "P1", "ws1");
  const id = db.insertEvent({ project: "p1", member: "asha", kind: "intent", text: "hi", source: "codex" });
  const row = db.db.prepare("SELECT source FROM events WHERE id = ?").get(id) as { source: string };
  assert.equal(row.source, "codex");
});

test("source attribution: defaults to claude-code when omitted", () => {
  const id = db.insertEvent({ project: "p1", member: "asha", kind: "progress", text: "yo" });
  const row = db.db.prepare("SELECT source FROM events WHERE id = ?").get(id) as { source: string };
  assert.equal(row.source, "claude-code");
});

const WS = "ws-prov"; // workspace under test for provider CRUD

test("providers: first created in a workspace becomes active; key round-trips encrypted", () => {
  const p = db.createProvider(WS, {
    label: "OpenAI",
    baseURL: "https://api.openai.com/v1",
    model: "gpt-4o",
    apiKey: "sk-secret-123",
  });
  assert.equal(p.active, true, "first provider in the workspace is auto-activated");
  assert.equal(p.workspaceId, WS);

  // The stored ciphertext is NOT the plaintext key.
  const row = db.db.prepare("SELECT api_key_enc FROM providers WHERE id = ?").get(p.id) as {
    api_key_enc: string;
  };
  assert.notEqual(row.api_key_enc, "sk-secret-123");
  assert.ok(row.api_key_enc.length > 0);

  // getActiveProvider(ws) decrypts it back.
  const active = db.getActiveProvider(WS);
  assert.equal(active?.id, p.id);
  assert.equal(active?.apiKey, "sk-secret-123");
});

test("providers: activate switches exactly one active; update keeps key when omitted", () => {
  const a = db.createProvider(WS, { label: "A", baseURL: "https://a.test/v1", model: "m", apiKey: "key-a" });
  const b = db.createProvider(WS, { label: "B", baseURL: "https://b.test/v1", model: "m", apiKey: "key-b" });

  assert.equal(db.setActiveProvider(b.id, WS), true);
  const actives = db.listProviders(WS).filter((p) => p.active);
  assert.equal(actives.length, 1);
  assert.equal(actives[0]?.id, b.id);

  // Update label without an apiKey leaves the encrypted key intact.
  db.updateProvider(a.id, WS, { label: "A2" });
  const reread = db.listProviders(WS).find((p) => p.id === a.id);
  assert.equal(reread?.label, "A2");
  assert.equal(reread?.apiKey, "key-a");
});

test("providers: a workspace cannot read or mutate another workspace's provider", () => {
  const mine = db.createProvider("ws-A", { label: "Mine", baseURL: "https://a.test/v1", model: "m", apiKey: "k" });

  // ws-B sees nothing of ws-A's, and its own active resolves independently.
  assert.equal(db.listProviders("ws-B").length, 0);
  assert.equal(db.getActiveProvider("ws-B"), undefined);

  // Mutations scoped to the wrong workspace are refused (ownership enforced).
  assert.equal(db.updateProvider(mine.id, "ws-B", { label: "hijack" }), undefined);
  assert.equal(db.setActiveProvider(mine.id, "ws-B"), false);
  assert.equal(db.deleteProvider(mine.id, "ws-B"), false);
  // ...and the provider is untouched in its real workspace.
  assert.equal(db.listProviders("ws-A")[0]?.label, "Mine");
});

test("providers: deleting the active provider promotes another in the same workspace", () => {
  const before = db.getActiveProvider(WS);
  assert.ok(before);
  assert.equal(db.deleteProvider(before!.id, WS), true);
  const after = db.getActiveProvider(WS);
  assert.ok(after, "an active provider remains after deleting the active one");
  assert.notEqual(after!.id, before!.id);
});
