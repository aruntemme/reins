import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Isolate the DB on a fresh temp file BEFORE importing anything that opens it.
process.env.REINS_DB = join(tmpdir(), `reins-seams-${randomUUID()}.db`);

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

test("snapshot ledger: record / list / latest are append-only and ordered", () => {
  db.ensureProject("p2", "P2", "ws1");
  const a = db.recordSnapshot({ workspaceId: "ws1", project: "p2", rootHash: "0xaaa", txHash: "0xt1" });
  const b = db.recordSnapshot({ workspaceId: "ws1", project: "p2", rootHash: "0xbbb", txHash: "0xt2" });
  assert.notEqual(a, b);

  const list = db.listSnapshots("p2");
  assert.equal(list.length, 2);
  // newest first
  assert.equal(list[0]?.root_hash, "0xbbb");
  assert.equal(list[1]?.root_hash, "0xaaa");

  const latest = db.latestSnapshot("p2");
  assert.equal(latest?.root_hash, "0xbbb");
  assert.equal(latest?.workspace_id, "ws1");
  assert.equal(latest?.anchored_tx, "");
});

test("snapshot ledger: setSnapshotAnchor records the on-chain anchor tx", () => {
  db.recordSnapshot({ workspaceId: "ws1", project: "p3", rootHash: "0xccc" });
  const ok = db.setSnapshotAnchor("0xccc", "0xANCHORTX");
  assert.equal(ok, true);
  const latest = db.latestSnapshot("p3");
  assert.equal(latest?.anchored_tx, "0xANCHORTX");

  // unknown root hash -> no-op, returns false
  assert.equal(db.setSnapshotAnchor("0xdoesnotexist", "0xZ"), false);
});

test("snapshot ledger: latestSnapshot is undefined for a project with none", () => {
  assert.equal(db.latestSnapshot("nope"), undefined);
});
