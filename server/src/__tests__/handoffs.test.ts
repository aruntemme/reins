import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

process.env.REINS_DB = join(tmpdir(), `reins-handoffs-${randomUUID()}.db`);
const db = await import("../db.js");

test("resolveHandoffs bulk-clears by member and optionally by kind", () => {
  db.ensureProject("hp", "HP", "w1");
  // asha: 3 mentions + 1 blocker; rui: 1 mention (must not be touched).
  db.createHandoff({ project: "hp", toMember: "asha", fromMember: "x", kind: "mention", text: "review PR 1" });
  db.createHandoff({ project: "hp", toMember: "asha", fromMember: "x", kind: "mention", text: "review PR 2" });
  db.createHandoff({ project: "hp", toMember: "asha", fromMember: "x", kind: "mention", text: "review PR 3" });
  db.createHandoff({ project: "hp", toMember: "asha", fromMember: "y", kind: "blocker", text: "API is down" });
  db.createHandoff({ project: "hp", toMember: "rui", fromMember: "x", kind: "mention", text: "ping rui" });

  assert.equal(db.incomingHandoffs("hp", "asha").length, 4);

  // Clear just asha's mentions.
  const n = db.resolveHandoffs("hp", { member: "asha", kind: "mention" });
  assert.equal(n, 3, "exactly the three mentions resolved");
  const left = db.incomingHandoffs("hp", "asha");
  assert.equal(left.length, 1);
  assert.equal(left[0].kind, "blocker", "the blocker survives a mention-only clear");
  assert.equal(db.incomingHandoffs("hp", "rui").length, 1, "another member's handoffs are untouched");

  // Clear the rest (no kind filter).
  const m = db.resolveHandoffs("hp", { member: "asha" });
  assert.equal(m, 1, "the remaining blocker resolved");
  assert.equal(db.incomingHandoffs("hp", "asha").length, 0, "asha's inbox is clear");
  assert.equal(db.resolvedHandoffs("hp", "asha").length, 4, "all four show up in history");

  // Idempotent: nothing left to resolve.
  assert.equal(db.resolveHandoffs("hp", { member: "asha" }), 0);
  assert.equal(db.incomingHandoffs("hp", "rui").length, 1, "rui still untouched");
});
