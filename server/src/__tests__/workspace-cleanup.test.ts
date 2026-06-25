import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Isolate the DB on a fresh temp file BEFORE importing anything that opens it.
process.env.REINS_DB = join(tmpdir(), `reins-wscleanup-${randomUUID()}.db`);

const db = await import("../db.js");
const auth = await import("../auth.js");

test("merge-workspace logic: reassignProjects moves all projects from->to", () => {
  const from = auth.createWorkspace("My Team (dup)");
  const to = auth.createWorkspace("My Team");

  db.ensureProject("alpha", "Alpha", from.id);
  db.ensureProject("beta", "Beta", from.id);
  // A project already in the destination must be untouched.
  db.ensureProject("gamma", "Gamma", to.id);

  const moved = db.reassignProjects(from.id, to.id);
  assert.equal(moved, 2);

  assert.equal(db.countProjects(from.id), 0);
  assert.equal(db.countProjects(to.id), 3);
  assert.equal(db.getProject("alpha").workspace_id, to.id);
  assert.equal(db.getProject("gamma").workspace_id, to.id);
});

test("move-project moves one project (and its snapshots), leaving siblings put", () => {
  const home = auth.createWorkspace("Home");
  const demo = auth.createWorkspace("Demo");

  db.ensureProject("real", "Real", home.id);
  db.ensureProject("seedling", "Seedling", home.id);
  db.recordSnapshot({ workspaceId: home.id, project: "seedling", rootHash: "0xabc" });

  const ok = db.moveProject("seedling", demo.id);
  assert.equal(ok, true);

  // The moved project and its snapshot ledger now live in demo...
  assert.equal(db.getProject("seedling").workspace_id, demo.id);
  assert.equal(db.listSnapshots("seedling")[0]!.workspace_id, demo.id);
  // ...while the sibling stays in home.
  assert.equal(db.getProject("real").workspace_id, home.id);
  assert.equal(db.countProjects(home.id), 1);
  assert.equal(db.countProjects(demo.id), 1);
});

test("move-project rejects an unknown project or target workspace", () => {
  const ws = auth.createWorkspace("Target");
  db.ensureProject("here", "Here", ws.id);

  assert.equal(db.moveProject("ghost", ws.id), false, "unknown project");
  assert.equal(db.moveProject("here", "no-such-ws"), false, "unknown workspace");
  // The project must be untouched after a rejected move.
  assert.equal(db.getProject("here").workspace_id, ws.id);
});

test("delete-workspace refuses while the workspace still owns projects", () => {
  const ws = auth.createWorkspace("Still Owns");
  db.ensureProject("owned", "Owned", ws.id);

  assert.equal(db.deleteWorkspace(ws.id), false, "must refuse with projects present");
  assert.ok(auth.getWorkspace(ws.id), "workspace must still exist");
});

test("delete-workspace removes an empty workspace and its tokens", () => {
  const ws = auth.createWorkspace("Empties");
  auth.mintToken(ws.id, "admin", "boot");
  auth.mintToken(ws.id, "ingest");
  assert.equal(auth.listTokens(ws.id).length, 2);

  // No projects -> deletion allowed.
  assert.equal(db.countProjects(ws.id), 0);
  assert.equal(db.deleteWorkspace(ws.id), true);

  assert.equal(auth.getWorkspace(ws.id), undefined);
  assert.equal(auth.listTokens(ws.id).length, 0, "tokens are cleaned up too");

  // Deleting a non-existent workspace returns false.
  assert.equal(db.deleteWorkspace("does-not-exist"), false);
});
