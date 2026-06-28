import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Isolate the DB on a fresh temp file BEFORE importing anything that opens it.
process.env.REINS_DB = join(tmpdir(), `reins-sync-${randomUUID()}.db`);

const { mergePack } = await import("../sync.js");
const db = await import("../db.js");
import type { ContextPack } from "../context-pack.js";

function samplePack(project = "demo"): ContextPack {
  return {
    v: 1,
    project,
    name: "Demo Project",
    goal: "ship the thing",
    generatedAt: Date.now(),
    members: [
      {
        member: "asha",
        name: "Asha",
        status: "active",
        headline: "wiring the API",
        goal: "land /api/ingest",
        workingOn: ["routes/api.ts", "db.ts"],
      },
      {
        member: "ben",
        name: "Ben",
        status: "blocked",
        headline: "waiting on schema",
        goal: "frontend board",
        workingOn: ["web/App.tsx"],
      },
    ],
    pending: [
      { member: "asha", text: "decide auth model", status: "open" },
      { member: "ben", text: "pick chart lib", status: "open" },
    ],
    rollup: {
      summary: "two members heads-down, one blocked",
      alignment: "aligned on the API contract",
      collisions: [{ area: "db.ts", members: ["asha", "ben"], note: "schema churn" }],
      risks: ["auth model undecided"],
    },
  };
}

test("mergePack: members, pending, and rollup all land in a fresh DB", () => {
  const pack = samplePack("merge-fresh");
  mergePack(pack);

  const members = db.listMembers("merge-fresh");
  assert.equal(members.length, 2);
  const asha = members.find((m: any) => m.member === "asha");
  assert.equal(asha.display_name, "Asha");
  assert.equal(asha.status, "active");
  assert.equal(asha.headline, "wiring the API");
  assert.equal(asha.goal, "land /api/ingest");
  assert.deepEqual(JSON.parse(asha.working_on), ["routes/api.ts", "db.ts"]);

  const pending = db.listPending("merge-fresh");
  assert.equal(pending.length, 2);
  assert.ok(pending.some((p: any) => p.text === "decide auth model"));

  const rollup: any = db.getRollup("merge-fresh");
  assert.equal(rollup.summary, "two members heads-down, one blocked");
  assert.equal(rollup.alignment, "aligned on the API contract");
  assert.deepEqual(JSON.parse(rollup.collisions), [
    { area: "db.ts", members: ["asha", "ben"], note: "schema churn" },
  ]);
  assert.deepEqual(JSON.parse(rollup.risks), ["auth model undecided"]);

  // Goal seeded from the pack.
  assert.equal((db.getProject("merge-fresh") as any).goal, "ship the thing");
});

test("mergePack: re-merging the same pack is idempotent (no duplication)", () => {
  const pack = samplePack("merge-idem");
  mergePack(pack);
  mergePack(pack);
  mergePack(pack);

  assert.equal(db.listMembers("merge-idem").length, 2);
  // Pending dedup by (member, text) across statuses.
  const pendingRows = db.db
    .prepare("SELECT * FROM pending WHERE project = ?")
    .all("merge-idem");
  assert.equal(pendingRows.length, 2);
});
