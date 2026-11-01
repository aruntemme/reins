import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

process.env.REINS_DB = join(tmpdir(), `reins-goals-${randomUUID()}.db`);
const db = await import("../db.js");

test("buildGoalsView derives progress + status from the checklist", () => {
  db.ensureProject("p1", "P1", "w1");
  const g = db.createGoal({ project: "p1", scope: "individual", member: "asha", title: "Ship auth" });
  db.addGoalItem({ goalId: g, text: "routes" });
  const i2 = db.addGoalItem({ goalId: g, text: "tests" });

  let goal = db.buildGoalsView("p1").find((x) => x.id === g)!;
  assert.equal(goal.scope, "individual");
  assert.equal(goal.member, "asha");
  assert.deepEqual([goal.progress.done, goal.progress.total], [0, 2]);
  assert.equal(goal.status, "todo");

  db.updateGoalItem(i2, { done: true });
  goal = db.buildGoalsView("p1").find((x) => x.id === g)!;
  assert.deepEqual([goal.progress.done, goal.progress.total, goal.progress.pct], [1, 2, 50]);
  assert.equal(goal.status, "in_progress");

  db.updateGoalItem(db.buildGoalsView("p1").find((x) => x.id === g)!.items[0]!.id, { done: true });
  assert.equal(db.buildGoalsView("p1").find((x) => x.id === g)!.status, "done");
});

test("a team goal rolls up its parented individual goals' items", () => {
  db.ensureProject("p2", "P2", "w1");
  const team = db.createGoal({ project: "p2", scope: "team", title: "Q3 milestone" });
  db.addGoalItem({ goalId: team, text: "spec" }); // own item, not done

  const child = db.createGoal({ project: "p2", scope: "individual", member: "rui", parentId: team, title: "my part" });
  const ci = db.addGoalItem({ goalId: child, text: "do it" });
  db.updateGoalItem(ci, { done: true });

  const t = db.buildGoalsView("p2").find((x) => x.id === team)!;
  assert.deepEqual([t.progress.done, t.progress.total], [0, 1], "own items only");
  assert.deepEqual([t.rollup.done, t.rollup.total], [1, 2], "own + child item");
  assert.equal(t.status, "in_progress", "team status reflects the rollup");
});

test("blocked overrides the derived status", () => {
  db.ensureProject("p3", "P3", "w1");
  const g = db.createGoal({ project: "p3", scope: "team", title: "X" });
  db.updateGoal(g, { blocked: true });
  const v = db.buildGoalsView("p3").find((x) => x.id === g)!;
  assert.equal(v.blocked, true);
  assert.equal(v.status, "blocked");
});

test("deleteGoal removes its items and orphans children (doesn't delete them)", () => {
  db.ensureProject("p4", "P4", "w1");
  const team = db.createGoal({ project: "p4", scope: "team", title: "parent" });
  const item = db.addGoalItem({ goalId: team, text: "a" });
  const child = db.createGoal({ project: "p4", scope: "individual", member: "x", parentId: team, title: "c" });

  assert.equal(db.deleteGoal(team), true);
  const v = db.buildGoalsView("p4");
  assert.ok(!v.find((x) => x.id === team), "team goal is gone");
  assert.equal(db.goalItemGoal(item), undefined, "its item is gone");
  assert.equal(v.find((x) => x.id === child)!.parentId, null, "child survives, orphaned");
});

test("ordering: team goals first, then by creation", () => {
  db.ensureProject("p5", "P5", "w1");
  const indiv = db.createGoal({ project: "p5", scope: "individual", member: "a", title: "i" });
  const team = db.createGoal({ project: "p5", scope: "team", title: "t" });
  assert.deepEqual(db.buildGoalsView("p5").map((g) => g.id), [team, indiv]);
});

test("goalItemProjectId / goalProjectId resolve for authorization", () => {
  db.ensureProject("p6", "P6", "w1");
  const g = db.createGoal({ project: "p6", scope: "team", title: "z" });
  const it = db.addGoalItem({ goalId: g, text: "q" });
  assert.equal(db.goalProjectId(g), "p6");
  assert.equal(db.goalItemGoal(it)!.project, "p6");
  assert.equal(db.goalProjectId("nope"), null);
});

test("goal lists fed to the distiller skip completed goals and are capped", () => {
  db.ensureProject("cap", "Cap", "w1");
  const done = db.createGoal({ project: "cap", scope: "team", title: "Finished goal" });
  db.updateGoalItem(db.addGoalItem({ goalId: done, text: "only step" }), { done: true });
  const empty = db.createGoal({ project: "cap", scope: "team", title: "No steps yet" });
  const open = db.createGoal({ project: "cap", scope: "team", title: "Half done" });
  db.updateGoalItem(db.addGoalItem({ goalId: open, text: "a" }), { done: true });
  db.addGoalItem({ goalId: open, text: "b" });
  const ids = db.openGoalsForMatch("cap", "asha").map((g) => g.id);
  assert.ok(!ids.includes(done), "a completed goal is not offered");
  assert.ok(ids.includes(empty) && ids.includes(open));

  for (let i = 0; i < 45; i++) {
    const g = db.createGoal({ project: "cap", scope: "team", title: `goal ${i}` });
    db.addGoalItem({ goalId: g, text: `step ${i}` });
  }
  assert.equal(db.openGoalsForMatch("cap", "asha").length, db.PROMPT_LIST_CAP);
  assert.equal(db.openGoalItemsForMatch("cap", "asha").length, db.PROMPT_LIST_CAP);
});

test("pruneStale drops dead invites/resets and blanks old raw event text only", () => {
  db.ensureProject("prune", "Prune", "w1");
  const t = Date.now();
  db.db.prepare("INSERT INTO invites (id, workspace_id, role, code_hash, expires_at, created_at) VALUES ('i-old','w1','member','h-old',?,?)").run(t - 1000, t - 9000);
  db.db.prepare("INSERT INTO invites (id, workspace_id, role, code_hash, expires_at, created_at) VALUES ('i-live','w1','member','h-live',?,?)").run(t + 99999, t);
  db.db.prepare("INSERT INTO password_resets (id, user_id, code_hash, expires_at, used_at, created_at) VALUES ('r-used','u','rh1',?,?,?)").run(t + 99999, t, t);
  db.db.prepare("INSERT INTO password_resets (id, user_id, code_hash, expires_at, created_at) VALUES ('r-live','u','rh2',?,?)").run(t + 99999, t);
  const oldEv = db.insertEvent({ project: "prune", member: "asha", kind: "progress", text: "old raw prompt" });
  const newEv = db.insertEvent({ project: "prune", member: "asha", kind: "progress", text: "fresh raw prompt" });
  db.db.prepare("UPDATE events SET created_at = ? WHERE id = ?").run(t - 40 * 24 * 60 * 60 * 1000, oldEv);
  db.addTimeline("prune", "asha", "did", "distilled summary stays");

  const r = db.pruneStale(30, t);
  assert.deepEqual(r, { invites: 1, resets: 1, events: 1 });
  const text = (id: string) => (db.db.prepare("SELECT text FROM events WHERE id = ?").get(id) as any).text;
  assert.equal(text(oldEv), "", "old raw text blanked");
  assert.equal(text(newEv), "fresh raw prompt");
  assert.equal(db.recentTimeline("prune", "asha").length, 1, "distilled state untouched");
  assert.equal(db.pruneStale(0, t).events, 0, "retention 0 keeps raw text forever");
});
