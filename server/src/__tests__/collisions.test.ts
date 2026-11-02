import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

process.env.REINS_DB = join(tmpdir(), `reins-collisions-${randomUUID()}.db`);
const db = await import("../db.js");
const { computeOverlaps, reconcileCollisions, reportsMergedPr, areaCovers, editWarnings } = await import("../collisions.js");
const { buildMemberPack } = await import("../context-pack.js");

test("merged-PR text signal: plain reports count, hedged ones don't", () => {
  for (const t of ["Merged PR #42 into main.", "The pull request was merged.", "Landed the PR for auth.", "PR #7 is merged now"]) {
    assert.equal(reportsMergedPr(t), true, t);
  }
  for (const t of ["Opened PR #42; it will be merged after review.", "Not merged yet — PR needs a rebase.", "Waiting for the PR to be merged.", "merged the two config files"]) {
    assert.equal(reportsMergedPr(t), false, t);
  }
});

test("areaCovers: same file, or a directory that holds it; free text never matches a path", () => {
  assert.equal(areaCovers("src/billing", "src/billing/invoice.ts"), true);
  assert.equal(areaCovers("src/billing/", "server/src/billing/invoice.ts"), true);
  assert.equal(areaCovers("invoice.ts", "src/billing/invoice.ts"), true);
  assert.equal(areaCovers("src/bill", "src/billing/invoice.ts"), false);
  assert.equal(areaCovers("the billing flow", "src/billing/invoice.ts"), false);
});

test("touches and dirty files collide only between present teammates", () => {
  const P = "ov";
  db.ensureProject(P, "Ov", "w1");
  for (const m of ["asha", "ravi", "ghost"]) db.ensureMember(P, m, m[0]!.toUpperCase() + m.slice(1));
  db.recordTouch(P, "asha", "server/src/db.ts");
  db.setMemberGit(P, "ravi", { branch: "main", defaultBranch: "main", dirtyFiles: ["src/db.ts"], dirty: 1 });
  db.recordTouch(P, "ghost", "server/src/db.ts");
  db.db.prepare("UPDATE members SET last_seen = ? WHERE project = ? AND member = 'ghost'").run(Date.now() - 5 * 86400_000, P);
  assert.deepEqual(computeOverlaps(P), [{ area: "server/src/db.ts", members: ["asha", "ravi"], kind: "file" }]);
  const w = editWarnings(P, "ravi", "server/src/db.ts");
  assert.deepEqual(w.warnings.map((x) => [x.kind, x.member]), [["touch", "asha"]], "the away teammate's touch never warns");
  // Blocker tied to a pending item: auto-closes when the item is done.
  const pid = db.upsertPending(P, "asha", "publish the schema");
  db.createHandoff({ project: P, toMember: "asha", fromMember: "ravi", kind: "blocker", text: "Ravi waits on the schema", ref: pid });
  reconcileCollisions(P);
  assert.equal(db.incomingHandoffs(P, "asha").filter((h: any) => h.kind === "blocker").length, 1);
  db.setPendingStatus(P, pid, "done");
  reconcileCollisions(P, { eventId: "evt-1" });
  const b = db.db.prepare("SELECT * FROM handoffs WHERE project = ? AND kind = 'blocker'").get(P) as any;
  assert.equal(b.status, "resolved");
  assert.equal(b.auto_code, "blocker_resolved");
  assert.equal(b.auto_event, "evt-1");
});

test("member pack: start is hard-capped, and what didn't fit arrives in a later delta", () => {
  const P = "cap";
  db.ensureProject(P, "Cap", "w2");
  db.ensureMember(P, "ravi", "Ravi");
  db.ensureMember(P, "asha", "Asha");
  for (let i = 0; i < 12; i++) {
    db.createDirective({ project: P, text: `Directive number ${i} — ${"keep the API stable and documented ".repeat(3)}`, targets: [], createdBy: "lead", ttlMs: 3600_000 });
  }
  const start = buildMemberPack(P, "ravi", { mode: "start" });
  assert.ok(start.text.length <= 1200, `start ≤ 1200 chars, got ${start.text.length}`);
  assert.ok(start.shown.length < 12, "not everything fits");
  let seen = start.shown;
  const d = buildMemberPack(P, "ravi", { mode: "delta", seen });
  assert.ok(d.text.length > 0 && d.text.length <= 700, `delta ≤ 700 chars, got ${d.text.length}`);
  assert.ok(d.shown.every((k) => !seen.includes(k)), "a delta never repeats a shown line");
  seen = [...seen, ...d.shown];
  for (let i = 0; i < 10 && buildMemberPack(P, "ravi", { mode: "delta", seen }).text; i++) {
    seen = [...seen, ...buildMemberPack(P, "ravi", { mode: "delta", seen }).shown];
  }
  assert.equal(buildMemberPack(P, "ravi", { mode: "delta", seen }).text, "", "eventually everything was shown once");
  // Teammates' routine headline changes never trigger a delta.
  db.upsertMemberState(P, "asha", { headline: "now doing something else entirely" });
  assert.equal(buildMemberPack(P, "ravi", { mode: "delta", seen }).text, "");
});

test("board: an untagged stored collision for a live pair shows once; other stored ones stay", async () => {
  const { projectSnapshot } = await import("../state.js");
  const P = "dup";
  db.ensureProject(P, "Dup", "w3");
  for (const [m, n] of [["alice", "Alice"], ["bob", "Bob"], ["carol", "Carol"]] as const) db.ensureMember(P, m, n);
  db.recordTouch(P, "alice", "src/payments/checkout.ts");
  db.recordTouch(P, "bob", "src/payments/checkout.ts");
  // Saved by a pre-`computed` rollup: same pair as the live overlap, plus an unrelated one.
  db.saveRollup(P, {
    summary: "s",
    alignment: "a",
    collisions: [
      { area: "src/payments/checkout.ts", members: ["bob", "alice"], note: "model copy" },
      { area: "the retry queue", members: ["Bob", "Carol"], note: "model-only" },
    ],
    risks: [],
  });
  const areas = projectSnapshot(P)!.rollup!.collisions.map((c: any) => `${c.area}|${c.computed ? "live" : "stored"}`);
  assert.deepEqual(areas.sort(), ["src/payments/checkout.ts|live", "the retry queue|stored"]);
});
