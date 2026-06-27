import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

process.env.REINS_DB = join(tmpdir(), `reins-traits-${randomUUID()}.db`);
const db = await import("../db.js");

const DAY = 24 * 60 * 60 * 1000;

test("add seeds a trait; reinforce grows confidence and observation count", () => {
  db.ensureProject("t1", "T1", "w1");
  const n = db.applyTraitOps("t1", "asha", [
    { op: "add", type: "tooling", statement: "reaches for TypeScript + Zod", evidence: "used zod schemas" },
  ]);
  assert.equal(n, 1);

  let prof = db.buildProfileView("t1", "asha");
  assert.equal(prof.length, 1);
  const t = prof[0]!;
  assert.equal(t.type, "tooling");
  assert.equal(t.observations, 1);
  const seed = t.confidence;

  // Reinforce the same trait by id.
  db.applyTraitOps("t1", "asha", [{ op: "reinforce", traitId: t.id, evidence: "zod again" }]);
  prof = db.buildProfileView("t1", "asha");
  assert.equal(prof[0]!.observations, 2);
  assert.ok(prof[0]!.confidence > seed, "confidence climbs toward 1 on reinforcement");
  assert.ok(prof[0]!.confidence < 1, "but never reaches certainty");
});

test("an 'add' that matches an existing active trait reinforces it instead of duplicating", () => {
  db.ensureProject("t2", "T2", "w1");
  db.applyTraitOps("t2", "rui", [{ op: "add", type: "quality", statement: "Insists on real tests, no stubs", evidence: "wrote real tests" }]);
  // Same statement (different casing) + type → dedupe to a reinforce.
  db.applyTraitOps("t2", "rui", [{ op: "add", type: "quality", statement: "insists on real tests, no stubs", evidence: "again" }]);
  const prof = db.buildProfileView("t2", "rui");
  assert.equal(prof.length, 1, "no duplicate trait");
  assert.equal(prof[0]!.observations, 2, "the matching add reinforced");
});

test("revise sharpens the wording and counts as reinforcement", () => {
  db.ensureProject("t3", "T3", "w1");
  db.applyTraitOps("t3", "ravi", [{ op: "add", type: "workflow", statement: "dives in fast", evidence: "started coding immediately" }]);
  const id = db.buildProfileView("t3", "ravi")[0]!.id;
  db.applyTraitOps("t3", "ravi", [{ op: "revise", traitId: id, statement: "prefers to spike a prototype before planning", evidence: "spiked first" }]);
  const t = db.buildProfileView("t3", "ravi")[0]!;
  assert.equal(t.statement, "prefers to spike a prototype before planning");
  assert.equal(t.observations, 2);
});

test("reinforce/revise of an unknown or foreign trait id is ignored", () => {
  db.ensureProject("t4", "T4", "w1");
  db.applyTraitOps("t4", "a", [{ op: "add", type: "concern", statement: "security-first", evidence: "flagged auth" }]);
  const aId = db.buildProfileView("t4", "a")[0]!.id;

  // Unknown id.
  assert.equal(db.applyTraitOps("t4", "a", [{ op: "reinforce", traitId: "nope", evidence: "x" }]), 0);
  // Real id but wrong member → must not cross-write.
  assert.equal(db.applyTraitOps("t4", "b", [{ op: "reinforce", traitId: aId, evidence: "x" }]), 0);
  assert.equal(db.buildProfileView("t4", "a")[0]!.observations, 1, "untouched");
});

test("confidence decays with time; a long-unseen trait drops below the floor and is hidden", () => {
  db.ensureProject("t5", "T5", "w1");
  db.applyTraitOps("t5", "c", [{ op: "add", type: "communication", statement: "terse, direct asks", evidence: "short prompts" }]);
  const now = db.now();

  // Right now: visible.
  assert.equal(db.buildProfileView("t5", "c", now).length, 1);
  // ~9 weeks later with no reinforcement: decayed past the floor → gone from the view.
  const faded = db.buildProfileView("t5", "c", now + 63 * DAY);
  assert.equal(faded.length, 0, "a stale preference fades instead of sticking");

  // But it still exists in the table (not deleted) — reinforcing revives it.
  db.applyTraitOps("t5", "c", [{ op: "add", type: "communication", statement: "terse, direct asks", evidence: "again" }]);
  assert.equal(db.buildProfileView("t5", "c").length, 1, "reinforcement brings it back");
});

test("decayedConfidence halves over one half-life", () => {
  const c = 0.8;
  const t0 = db.now();
  const oneHalfLife = 21 * DAY;
  const after = db.decayedConfidence(c, t0, t0 + oneHalfLife);
  assert.ok(Math.abs(after - 0.4) < 1e-9, "exactly halved after the half-life");
});

test("dismiss removes a trait from the profile and from match candidates", () => {
  db.ensureProject("t6", "T6", "w1");
  db.applyTraitOps("t6", "d", [{ op: "add", type: "tooling", statement: "prefers SQLite", evidence: "chose sqlite" }]);
  const id = db.buildProfileView("t6", "d")[0]!.id;
  assert.equal(db.dismissTrait(id), true);
  assert.equal(db.buildProfileView("t6", "d").length, 0, "gone from the profile");
  assert.equal(db.openTraitsForMatch("t6", "d").length, 0, "not offered to the distiller");
  assert.equal(db.dismissTrait(id), false, "dismissing again is a no-op");
});

test("updateTrait edits the wording without bumping observations", () => {
  db.ensureProject("t7", "T7", "w1");
  db.applyTraitOps("t7", "e", [{ op: "add", type: "quality", statement: "wants polish", evidence: "iterated on UI" }]);
  const before = db.buildProfileView("t7", "e")[0]!;
  assert.equal(db.updateTrait(before.id, { statement: "high bar for UI polish" }), true);
  const after = db.buildProfileView("t7", "e")[0]!;
  assert.equal(after.statement, "high bar for UI polish");
  assert.equal(after.observations, before.observations, "an edit is not a new observation");
});

test("buildProfileView returns strongest-first", () => {
  db.ensureProject("t8", "T8", "w1");
  db.applyTraitOps("t8", "f", [
    { op: "add", type: "tooling", statement: "weak one", evidence: "x" },
    { op: "add", type: "quality", statement: "strong one", evidence: "y" },
  ]);
  // Reinforce the second twice so it outranks the first.
  const strong = db.buildProfileView("t8", "f").find((t) => t.statement === "strong one")!;
  db.applyTraitOps("t8", "f", [{ op: "reinforce", traitId: strong.id, evidence: "y2" }]);
  db.applyTraitOps("t8", "f", [{ op: "reinforce", traitId: strong.id, evidence: "y3" }]);
  const prof = db.buildProfileView("t8", "f");
  assert.equal(prof[0]!.statement, "strong one", "higher confidence sorts first");
});
