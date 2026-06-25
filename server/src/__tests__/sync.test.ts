import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// Isolate the DB on a fresh temp file BEFORE importing anything that opens it.
process.env.REINS_DB = join(tmpdir(), `reins-sync-${randomUUID()}.db`);

const { mergePack, syncPush } = await import("../sync.js");
const db = await import("../db.js");
const { buildContextPack } = await import("../context-pack.js");
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

test("REAL 0G round-trip: syncPush returns a hash; a SECOND DB syncPull reconstructs the project", { timeout: 120_000 }, async () => {
  if (process.env.OG_STORAGE !== "on") {
    assert.fail("OG_STORAGE must be 'on' for the real 0G round-trip test. Re-run with OG_STORAGE=on.");
  }
  if (!db.db) assert.fail("db not open");

  // Seed a small project in THIS (first) temp DB, then push to 0G Storage.
  const project = `roundtrip-${randomUUID().slice(0, 8)}`;
  const pack = samplePack(project);
  mergePack(pack); // seeds members/pending/rollup/goal locally

  const { rootHash, txHash } = await syncPush(project);
  assert.ok(rootHash && rootHash.length > 0, "syncPush must return a non-empty root hash");
  console.error(`[round-trip] pushed ${project} -> root=${rootHash} tx=${txHash}`);

  // The original pack we expect the puller to reconstruct (built from the seeded DB).
  const original = buildContextPack(project);

  // Pull in a genuinely SEPARATE instance: a child process with its own fresh
  // REINS_DB. It downloads BY HASH ALONE (no shared DB) and prints the merged
  // result as JSON for us to compare.
  const secondDb = join(tmpdir(), `reins-sync-pull-${randomUUID()}.db`);
  const here = fileURLToPath(import.meta.url);
  const helper = join(here, "..", "pull-helper.mjs");

  const out = execFileSync(
    process.execPath,
    ["--import", "tsx", helper, rootHash],
    {
      env: { ...process.env, REINS_DB: secondDb, OG_STORAGE: "on" },
      encoding: "utf8",
      timeout: 110_000,
    }
  );

  // The helper prints exactly one JSON line on stdout.
  const line = out.trim().split("\n").filter(Boolean).pop() || "{}";
  const pulled = JSON.parse(line) as {
    project: string;
    members: { member: string; name: string; status: string; headline: string; goal: string; workingOn: string[] }[];
    pending: { member: string; text: string; status: string }[];
    goal: string;
  };

  assert.equal(pulled.project, project);
  assert.equal(pulled.goal, original.goal);

  // Members reconstructed in the second DB match the original (order-independent).
  const byId = (ms: any[]) => Object.fromEntries(ms.map((m) => [m.member, m]));
  const origM = byId(original.members);
  const pullM = byId(pulled.members);
  assert.deepEqual(Object.keys(pullM).sort(), Object.keys(origM).sort());
  for (const id of Object.keys(origM)) {
    assert.equal(pullM[id].name, origM[id].name, `name for ${id}`);
    assert.equal(pullM[id].status, origM[id].status, `status for ${id}`);
    assert.equal(pullM[id].headline, origM[id].headline, `headline for ${id}`);
    assert.equal(pullM[id].goal, origM[id].goal, `goal for ${id}`);
    assert.deepEqual(pullM[id].workingOn, origM[id].workingOn, `workingOn for ${id}`);
  }

  // Pending reconstructed.
  const pulledTexts = pulled.pending.map((p) => p.text).sort();
  const origTexts = original.pending.map((p) => p.text).sort();
  assert.deepEqual(pulledTexts, origTexts);
});
