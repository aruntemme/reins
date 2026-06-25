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
