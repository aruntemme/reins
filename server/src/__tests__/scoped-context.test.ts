import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Fresh isolated DB. MUST be set BEFORE importing anything that opens the DB.
const DB = join(tmpdir(), `reins-scoped-${randomUUID()}.db`);
process.env.REINS_DB = DB;

const {
  scoreRelevance,
  tokenize,
  buildContextPack,
  buildScopedContextPack,
  renderContextPack,
} = await import("../context-pack.js");
const db = await import("../db.js");

// ── scoreRelevance: pure unit tests ──────────────────────────────
test("scoreRelevance: a present query term scores higher than an absent one", () => {
  const present = scoreRelevance("working on the auth login flow", "auth");
  const absent = scoreRelevance("working on the billing dashboard", "auth");
  assert.ok(present > absent, `present(${present}) should beat absent(${absent})`);
  assert.equal(absent, 0);
});

test("scoreRelevance: is case-insensitive", () => {
  const lower = scoreRelevance("auth flow", "auth");
  const upper = scoreRelevance("AUTH FLOW", "AuTh");
  assert.equal(lower, upper);
  assert.ok(lower > 0);
});

test("scoreRelevance: empty query is neutral (zero)", () => {
  assert.equal(scoreRelevance("anything at all", ""), 0);
  assert.equal(scoreRelevance("anything at all", "   "), 0);
  // A query of only stop words has no signal terms -> neutral too.
  assert.equal(scoreRelevance("anything at all", "the and of"), 0);
});

test("scoreRelevance: more matching terms scores higher", () => {
  const two = scoreRelevance("auth login session token", "auth token");
  const one = scoreRelevance("auth login session token", "auth billing");
  assert.ok(two > one);
});

test("tokenize: drops stop words and punctuation, lowercases", () => {
  assert.deepEqual(tokenize("The Auth-Flow, and login!"), ["auth", "flow", "login"]);
});

// ── buildScopedContextPack: integration over a seeded DB ─────────
const PROJECT = "scoped-proj";

// Seed members of differing relevance to an "auth" task.
db.ensureProject(PROJECT, "Scoped Project");
db.setGoal(PROJECT, "Ship the product");

// On-topic member.
db.ensureMember(PROJECT, "alice", "Alice");
db.upsertMemberState(PROJECT, "alice", {
  status: "active",
  headline: "building the auth login flow",
  goal: "secure authentication",
  workingOn: ["auth tokens", "login session"],
});

// Off-topic members.
db.ensureMember(PROJECT, "bob", "Bob");
db.upsertMemberState(PROJECT, "bob", {
  status: "active",
  headline: "designing the marketing landing page",
  goal: "pretty homepage",
  workingOn: ["hero banner", "css gradients"],
});
db.ensureMember(PROJECT, "carol", "Carol");
db.upsertMemberState(PROJECT, "carol", {
  status: "idle",
  headline: "writing billing invoices",
  goal: "invoice exports",
  workingOn: ["pdf rendering"],
});
db.ensureMember(PROJECT, "dave", "Dave");
db.upsertMemberState(PROJECT, "dave", {
  status: "idle",
  headline: "tuning the database indexes",
  goal: "faster queries",
  workingOn: ["sqlite pragmas"],
});

// Pending of differing relevance.
db.upsertPending(PROJECT, "bob", "review the marketing copy");
db.upsertPending(PROJECT, "alice", "add auth rate limiting to login");
db.upsertPending(PROJECT, "carol", "export billing reports");

test("buildContextPack stays back-compat: returns everything, unranked-by-relevance", () => {
  const full = buildContextPack(PROJECT);
  assert.equal(full.members.length, 4);
  assert.equal(full.pending.length, 3);
  assert.equal(full.goal, "Ship the product");
});

test("buildScopedContextPack with no options matches buildContextPack contents", () => {
  const full = buildContextPack(PROJECT);
  const scoped = buildScopedContextPack(PROJECT);
  assert.equal(scoped.members.length, full.members.length);
  assert.equal(scoped.pending.length, full.pending.length);
  assert.deepEqual(
    scoped.members.map((m) => m.member).sort(),
    full.members.map((m) => m.member).sort()
  );
});

test("query ranks on-topic members + pending first", () => {
  const scoped = buildScopedContextPack(PROJECT, { query: "auth login flow" });
  assert.equal(scoped.members[0]?.member, "alice", "auth member should rank first");
  assert.equal(scoped.pending[0]?.member, "alice", "auth pending should rank first");
  // Goal + summary always retained.
  assert.equal(scoped.goal, "Ship the product");
});

test("member focus puts the chosen member first regardless of query", () => {
  const scoped = buildScopedContextPack(PROJECT, { member: "dave", query: "auth login" });
  assert.equal(scoped.members[0]?.member, "dave");
});

test("limit trims members + pending to the token budget but keeps goal", () => {
  const scoped = buildScopedContextPack(PROJECT, { query: "auth login flow", limit: 20 });
  assert.ok(scoped.members.length < 4, "members should be trimmed");
  // The most relevant member must survive the trim.
  assert.equal(scoped.members[0]?.member, "alice");
  assert.equal(scoped.goal, "Ship the product");
});

test("scoped render is smaller (fewer chars) than the full render", () => {
  const full = renderContextPack(buildContextPack(PROJECT), { from: "local" });
  const scoped = renderContextPack(
    buildScopedContextPack(PROJECT, { query: "auth login flow", limit: 20 }),
    { from: "local" }
  );
  assert.ok(
    scoped.length < full.length,
    `scoped(${scoped.length}) should be smaller than full(${full.length})`
  );
});

test("focused member survives even when alone it exceeds the budget", () => {
  const scoped = buildScopedContextPack(PROJECT, { member: "alice", limit: 1 });
  assert.equal(scoped.members[0]?.member, "alice");
});
