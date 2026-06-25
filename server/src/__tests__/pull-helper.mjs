/**
 * Round-trip test helper. Runs as a SEPARATE process with its own REINS_DB so
 * the pull side shares NO state with the push side: it reconstructs a project
 * from a 0G Storage root hash alone. Prints one JSON line describing the merged
 * result for the parent test to assert against.
 *
 * Usage: node --import tsx pull-helper.mjs <rootHash>
 */
const rootHash = process.argv[2];
if (!rootHash) {
  console.error("usage: pull-helper.mjs <rootHash>");
  process.exit(2);
}

const { syncPull } = await import("../sync.js");
const db = await import("../db.js");

const { project } = await syncPull(rootHash);

const members = db.listMembers(project).map((m) => ({
  member: m.member,
  name: m.display_name,
  status: m.status,
  headline: m.headline,
  goal: m.goal,
  workingOn: JSON.parse(m.working_on || "[]"),
}));
const pending = db.listPending(project).map((p) => ({
  member: p.member,
  text: p.text,
  status: p.status,
}));
const goal = db.getProject(project)?.goal || "";

process.stdout.write(JSON.stringify({ project, members, pending, goal }) + "\n");
