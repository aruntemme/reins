/**
 * Seed believable demo projects so the dashboard has something to show.
 *   npm run seed -- --local   -> writes a pre-distilled demo board directly (no LLM, instant)
 *   npm run seed              -> seeds project "atlas" via the running server (real pipeline)
 *
 * --local fills the same fields the distillation pipeline would, so the UI looks real
 * without an LLM. Set REINS_WORKSPACE to scope the demo projects to a workspace
 * (needed when auth is on); defaults to "default".
 */
import {
  db, ensureProject, setGoal, ensureMember, insertEvent, upsertPending, saveRollup, now,
} from "./db.js";

const LOCAL = process.argv.includes("--local");
const URL = (process.env.REINS_URL || "http://localhost:4319").replace(/\/$/, "");
const WORKSPACE = process.env.REINS_WORKSPACE || "default";

function setMember(project: string, member: string, name: string, patch: Record<string, unknown>) {
  ensureMember(project, member, name);
  const cols = Object.keys(patch);
  db.prepare(
    `UPDATE members SET ${cols.map((c) => `${c} = @${c}`).join(", ")}, updated_at=@ts, last_seen=@ts
     WHERE project=@project AND member=@member`
  ).run({ ...patch, ts: now(), project, member });
}
function tl(project: string, member: string, kind: string, summary: string) {
  db.prepare(
    "INSERT INTO timeline (id, project, member, kind, summary, created_at) VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?)"
  ).run(project, member, kind, summary, now());
}

function seedAtlas() {
  const P = "atlas";
  ensureProject(P, "Atlas", WORKSPACE);
  setGoal(P, "Ship the new payments checkout: one-tap pay, 3-D Secure, and webhooks by end of quarter.", "sofia");

  setMember(P, "sofia", "Sofia Almeida", {
    headline: "Wiring 3-D Secure into the checkout flow and reconciling the webhook retries",
    goal: "Lead the checkout rewrite to GA",
    status: "active",
    working_on: JSON.stringify(["checkout/three-ds.ts", "webhooks/retry.ts"]),
  });
  tl(P, "sofia", "did", "Checkout now falls back to 3-D Secure when the issuer requires it");
  tl(P, "sofia", "decided", "Retry webhooks with exponential backoff, cap at 24h");

  setMember(P, "mateo", "Mateo Rossi", {
    headline: "Building the one-tap pay button and the saved-cards drawer",
    goal: "Frontend for the new checkout",
    status: "active",
    working_on: JSON.stringify(["ui/pay-button.tsx", "ui/cards-drawer.tsx"]),
  });
  tl(P, "mateo", "did", "One-tap pay button shipped behind a flag");
  tl(P, "mateo", "blocked", "Needs the webhook event shape finalized to show payment status");

  setMember(P, "yuki", "Yuki Tanaka", {
    headline: "Hardening the webhooks endpoint and signing events",
    goal: "Reliable, verifiable webhooks",
    status: "blocked",
    working_on: JSON.stringify(["webhooks/sign.ts", "webhooks/retry.ts"]),
  });
  tl(P, "yuki", "did", "Webhook payloads are now HMAC-signed");
  tl(P, "yuki", "blocked", "Waiting on Sofia's retry schema before finalizing the event shape");

  setMember(P, "lukas", "Lukas Novak", {
    headline: "Load-testing checkout and chasing a p99 latency spike",
    goal: "Keep checkout under 300ms p99",
    status: "active",
    working_on: JSON.stringify(["bench/checkout.ts"]),
  });
  tl(P, "lukas", "did", "Found a slow query in the cards lookup; added an index");

  upsertPending(P, "yuki", "Finalize the webhook event shape so the UI can render payment status");
  upsertPending(P, "sofia", "Decide whether saved cards are workspace- or user-scoped");
  upsertPending(P, "lukas", "Add a p99 latency alert to the checkout dashboard");

  saveRollup(P, {
    summary:
      "The checkout rewrite is on track. 3-D Secure and signed webhooks are in; the team is converging on the webhook event shape, which a couple of people are waiting on. One latency regression was found and indexed away.",
    alignment:
      "All four workstreams (3-D Secure, one-tap UI, webhooks, performance) map directly to the GA goal.",
    collisions: [
      { area: "webhooks/retry.ts", members: ["sofia", "yuki"], note: "Both editing retry logic; coordinate before merge." },
    ],
    risks: [
      "Mateo and Yuki both blocked on the webhook event shape",
      "Saved-cards scoping still undecided",
    ],
  });
}

function seedNimbus() {
  const P = "nimbus";
  ensureProject(P, "Nimbus", WORKSPACE);
  setGoal(P, "Cut deploy time in half: parallel builds, warm caches, and a one-command rollback.", "aisha");

  setMember(P, "aisha", "Aisha Khan", {
    headline: "Parallelizing the build graph and warming the dependency cache",
    goal: "Halve CI build time",
    status: "active",
    working_on: JSON.stringify(["ci/build-graph.ts", "ci/cache.ts"]),
  });
  tl(P, "aisha", "did", "Build graph now runs independent targets in parallel");

  setMember(P, "nikolai", "Nikolai Petrov", {
    headline: "Writing the one-command rollback and pinning previous releases",
    goal: "Safe, instant rollback",
    status: "active",
    working_on: JSON.stringify(["deploy/rollback.ts"]),
  });
  tl(P, "nikolai", "decided", "Keep the last 5 releases warm for instant rollback");

  setMember(P, "emma", "Emma Lindqvist", {
    headline: "Idle: finished the cache-hit metrics dashboard",
    goal: "Observability for the build pipeline",
    status: "idle",
    working_on: JSON.stringify([]),
  });
  tl(P, "emma", "did", "Shipped a cache-hit-rate dashboard");

  upsertPending(P, "aisha", "Document the cache key strategy so teams can opt in");
  upsertPending(P, "nikolai", "Decide the rollback retention window (5 vs 10 releases)");

  saveRollup(P, {
    summary:
      "Build times are coming down: parallel builds and a warm cache are in, and a one-command rollback is landing. No blockers right now.",
    alignment: "On track to halve deploy time.",
    collisions: [],
    risks: ["Rollback retention window undecided"],
  });
}

function clearProject(p: string) {
  for (const t of ["events", "members", "timeline", "pending", "handoffs", "rollup"]) {
    try { db.prepare(`DELETE FROM ${t} WHERE project = ?`).run(p); } catch { /* table may differ */ }
  }
  db.prepare("DELETE FROM projects WHERE id = ?").run(p);
}

function localOnly() {
  // Idempotent: clear the projects we manage (incl. the old "reins" demo) first.
  for (const p of ["atlas", "nimbus", "reins"]) clearProject(p);
  seedAtlas();
  seedNimbus();
  console.log(`Seeded demo board (no LLM) into workspace "${WORKSPACE}". Projects: atlas, nimbus`);
}

async function viaServer() {
  await fetch(`${URL}/api/projects/atlas/goal`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ goal: "Ship the new payments checkout by end of quarter.", by: "sofia" }),
  });
  const events = [
    { member: "sofia", displayName: "Sofia Almeida", kind: "intent", text: "Wiring 3-D Secure into the checkout flow and reconciling webhook retries." },
    { member: "mateo", displayName: "Mateo Rossi", kind: "intent", text: "Building the one-tap pay button; need the webhook event shape finalized." },
    { member: "yuki", displayName: "Yuki Tanaka", kind: "summary", text: "Webhook payloads are HMAC-signed now. Blocked on Sofia's retry schema before I finalize the event shape." },
  ];
  for (const e of events) {
    const r = await fetch(`${URL}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "atlas", ...e }),
    });
    console.log(e.member, e.kind, "->", r.status);
    await new Promise((res) => setTimeout(res, 600));
  }
  console.log("\nSeeded via real pipeline. Project: atlas");
}

if (LOCAL) localOnly();
else viaServer().catch((e) => { console.error(e); process.exit(1); });
