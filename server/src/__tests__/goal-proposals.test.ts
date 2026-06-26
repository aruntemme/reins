import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

process.env.REINS_DB = join(tmpdir(), `reins-goalprop-${randomUUID()}.db`);
const db = await import("../db.js");

test("applyGoalOps files proposals; nothing is applied until accepted", () => {
  db.ensureProject("p1", "P1", "w1");
  const g = db.createGoal({ project: "p1", scope: "individual", member: "asha", title: "Ship auth" });
  const item = db.addGoalItem({ goalId: g, text: "write tests" });

  const n = db.applyGoalOps("p1", "asha", [
    { op: "check_item", itemId: item, reason: "ran the auth tests, all green" },
    { op: "add_item", goalId: g, text: "wire reset email", reason: "mentioned as a follow-up" },
  ], "evt-1");
  assert.equal(n, 2, "two proposals filed");

  // The checklist is untouched until a human accepts.
  const view = db.buildGoalsView("p1").find((x) => x.id === g)!;
  assert.equal(view.items.find((i) => i.id === item)!.done, false, "item still open");
  assert.equal(view.items.length, 1, "no new item yet");

  const props = db.listGoalProposals("p1");
  assert.equal(props.length, 2);
  assert.equal(db.countPendingProposals("p1"), 2);
  const check = props.find((p) => p.kind === "check_item")!;
  assert.equal(check.itemText, "write tests");
  assert.equal(check.evidence, "evt-1");
  assert.equal(check.member, "asha");
});

test("createGoalProposal dedupes an identical pending proposal", () => {
  db.ensureProject("p2", "P2", "w1");
  const g = db.createGoal({ project: "p2", scope: "team", title: "Q3" });
  const item = db.addGoalItem({ goalId: g, text: "spec" });
  const a = db.createGoalProposal({ project: "p2", goalId: g, itemId: item, kind: "check_item", reason: "x" });
  const b = db.createGoalProposal({ project: "p2", goalId: g, itemId: item, kind: "check_item", reason: "y" });
  assert.ok(a, "first filed");
  assert.equal(b, null, "duplicate suppressed");
  assert.equal(db.countPendingProposals("p2"), 1);
});

test("createGoalProposal refuses to propose checking an already-done item", () => {
  db.ensureProject("p3", "P3", "w1");
  const g = db.createGoal({ project: "p3", scope: "individual", member: "rui", title: "t" });
  const item = db.addGoalItem({ goalId: g, text: "done already" });
  db.updateGoalItem(item, { done: true });
  assert.equal(db.createGoalProposal({ project: "p3", goalId: g, itemId: item, kind: "check_item", reason: "z" }), null);
});

test("acceptGoalProposal applies the change and marks it accepted", () => {
  db.ensureProject("p4", "P4", "w1");
  const g = db.createGoal({ project: "p4", scope: "individual", member: "mei", title: "t" });
  const item = db.addGoalItem({ goalId: g, text: "ship" });
  const pid = db.createGoalProposal({ project: "p4", goalId: g, itemId: item, kind: "check_item", reason: "done", evidence: "evt-9" })!;

  const goal = db.acceptGoalProposal(pid);
  assert.ok(goal, "accept returns the goal");
  const it = db.buildGoalsView("p4").find((x) => x.id === g)!.items.find((i) => i.id === item)!;
  assert.equal(it.done, true, "item now done");
  assert.equal(it.origin, "auto", "marked auto");
  assert.equal(it.evidence, "evt-9", "evidence recorded");
  assert.equal(db.countPendingProposals("p4"), 0, "no longer pending");
  assert.equal(db.acceptGoalProposal(pid), null, "can't accept twice");
});

test("acceptGoalProposal add_item adds an auto item; block_goal blocks it", () => {
  db.ensureProject("p5", "P5", "w1");
  const g = db.createGoal({ project: "p5", scope: "team", title: "t" });
  const add = db.createGoalProposal({ project: "p5", goalId: g, kind: "add_item", text: "new sub-task", reason: "spotted" })!;
  db.acceptGoalProposal(add);
  const view = db.buildGoalsView("p5").find((x) => x.id === g)!;
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0]!.text, "new sub-task");
  assert.equal(view.items[0]!.origin, "auto");

  const block = db.createGoalProposal({ project: "p5", goalId: g, kind: "block_goal", reason: "stuck" })!;
  db.acceptGoalProposal(block);
  assert.equal(db.buildGoalsView("p5").find((x) => x.id === g)!.status, "blocked");
});

test("dismissGoalProposal drops it without applying", () => {
  db.ensureProject("p6", "P6", "w1");
  const g = db.createGoal({ project: "p6", scope: "individual", member: "x", title: "t" });
  const item = db.addGoalItem({ goalId: g, text: "thing" });
  const pid = db.createGoalProposal({ project: "p6", goalId: g, itemId: item, kind: "check_item", reason: "?" })!;
  db.dismissGoalProposal(pid);
  assert.equal(db.countPendingProposals("p6"), 0);
  assert.equal(db.buildGoalsView("p6").find((x) => x.id === g)!.items[0]!.done, false, "not applied");
});

test("openGoalItemsForMatch sees a member's own + team items, not other members'", () => {
  db.ensureProject("p7", "P7", "w1");
  const team = db.createGoal({ project: "p7", scope: "team", title: "team" });
  db.addGoalItem({ goalId: team, text: "shared" });
  const mine = db.createGoal({ project: "p7", scope: "individual", member: "asha", title: "mine" });
  db.addGoalItem({ goalId: mine, text: "asha-only" });
  const other = db.createGoal({ project: "p7", scope: "individual", member: "rui", title: "other" });
  db.addGoalItem({ goalId: other, text: "rui-only" });

  const seen = db.openGoalItemsForMatch("p7", "asha").map((i) => i.text).sort();
  assert.deepEqual(seen, ["asha-only", "shared"], "rui's item is hidden from asha's matcher");
});
