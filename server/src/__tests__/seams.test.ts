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

test("providers: first created becomes active; key round-trips encrypted", () => {
  const p = db.createProvider({
    label: "OpenAI",
    baseURL: "https://api.openai.com/v1",
    model: "gpt-4o",
    apiKey: "sk-secret-123",
  });
  assert.equal(p.active, true, "first provider is auto-activated");

  // The stored ciphertext is NOT the plaintext key.
  const row = db.db.prepare("SELECT api_key_enc FROM providers WHERE id = ?").get(p.id) as {
    api_key_enc: string;
  };
  assert.notEqual(row.api_key_enc, "sk-secret-123");
  assert.ok(row.api_key_enc.length > 0);

  // getActiveProvider decrypts it back.
  const active = db.getActiveProvider();
  assert.equal(active?.id, p.id);
  assert.equal(active?.apiKey, "sk-secret-123");
});

test("providers: activate switches exactly one active; update keeps key when omitted", () => {
  const a = db.createProvider({ label: "A", baseURL: "https://a.test/v1", model: "m", apiKey: "key-a" });
  const b = db.createProvider({ label: "B", baseURL: "https://b.test/v1", model: "m", apiKey: "key-b" });

  assert.equal(db.setActiveProvider(b.id), true);
  const actives = db.listProviders().filter((p) => p.active);
  assert.equal(actives.length, 1);
  assert.equal(actives[0]?.id, b.id);

  // Update label without an apiKey leaves the encrypted key intact.
  db.updateProvider(a.id, { label: "A2" });
  const reread = db.listProviders().find((p) => p.id === a.id);
  assert.equal(reread?.label, "A2");
  assert.equal(reread?.apiKey, "key-a");
});

test("providers: deleting the active provider promotes another", () => {
  const before = db.getActiveProvider();
  assert.ok(before);
  assert.equal(db.deleteProvider(before!.id), true);
  // Some provider is still active (one of the remaining), never zero.
  const after = db.getActiveProvider();
  assert.ok(after, "an active provider remains after deleting the active one");
  assert.notEqual(after!.id, before!.id);
});
