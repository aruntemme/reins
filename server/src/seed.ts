/**
 * Seed a believable project so the dashboard has something to show.
 *   npm run seed            -> seeds via the running server (REAL pipeline; needs LLM configured)
 *   npm run seed -- --local -> writes a pre-distilled demo board directly (no LLM, instant)
 *
 * --local fills the same fields the distillation pipeline would, so the UI looks real
 * without an LLM key. It is illustrative demo data, not a substitute for the pipeline.
 */
import { db, setGoal, ensureMember, insertEvent, upsertPending, saveRollup, now } from "./db.js";

const LOCAL = process.argv.includes("--local");
const URL = (process.env.REINS_URL || "http://localhost:4319").replace(/\/$/, "");
const PROJECT = "reins";

const events: { member: string; displayName: string; kind: string; text: string }[] = [
  { member: "praveen", displayName: "Praveen", kind: "intent", text: "Build the live distillation pipeline: triage -> extract -> reconcile agents over an OpenAI-compatible LLM. Starting on the reconcile tool-calling loop." },
  { member: "praveen", displayName: "Praveen", kind: "summary", text: "Reconcile agent now updates member headline/goal/status and surfaces pending items via tool calls. Next: project rollup synthesizer." },
  { member: "asha", displayName: "Asha", kind: "intent", text: "Designing the dashboard in Next.js with a light editorial theme, monospace status labels, no kanban." },
  { member: "asha", displayName: "Asha", kind: "summary", text: "Hero + team grid laid out. Need the SSE stream endpoint shape finalized before wiring live updates." },
  { member: "ravi", displayName: "Ravi", kind: "intent", text: "Setting up the MCP server so any teammate's agent can pull reins_context. Also touching the reconcile schema." },
  { member: "ravi", displayName: "Ravi", kind: "summary", text: "MCP exposes reins_context/reins_pending/reins_member. I edited reconcile.ts. Heads up Praveen, we both touched it." },
];

async function viaServer() {
  await fetch(`${URL}/api/projects/${PROJECT}/goal`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ goal: "Ship the Reins MVP: hook → live distilled team context → dashboard + MCP retrieval.", by: "praveen" }),
  });
  for (const e of events) {
    const r = await fetch(`${URL}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: PROJECT, ...e }),
    });
    console.log(e.member, e.kind, "->", r.status);
    await new Promise((res) => setTimeout(res, 600));
  }
  console.log("\nSeeded via real pipeline. Project:", PROJECT);
}

function setMember(member: string, name: string, patch: Record<string, unknown>) {
  ensureMember(PROJECT, member, name);
  const cols = Object.keys(patch);
  db.prepare(
    `UPDATE members SET ${cols.map((c) => `${c} = @${c}`).join(", ")}, updated_at=@ts, last_seen=@ts
     WHERE project=@project AND member=@member`
  ).run({ ...patch, ts: now(), project: PROJECT, member });
}
function tl(member: string, kind: string, summary: string) {
  db.prepare(
    "INSERT INTO timeline (id, project, member, kind, summary, created_at) VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?)"
  ).run(PROJECT, member, kind, summary, now());
}

function localOnly() {
  setGoal(PROJECT, "Ship the Reins MVP: hook → live distilled team context → dashboard + MCP retrieval.", "praveen");
  for (const e of events) insertEvent({ project: PROJECT, member: e.member, kind: e.kind, text: e.text });

  setMember("praveen", "Praveen", {
    headline: "Wiring the project rollup synthesizer after finishing the reconcile loop",
    goal: "Stand up the full triage → extract → reconcile → rollup distillation pipeline",
    status: "active",
    working_on: JSON.stringify(["pipeline/reconcile.ts", "pipeline/rollup.ts", "llm/agent.ts"]),
  });
  tl("praveen", "did", "Reconcile agent updates headline/goal/status via tool calls");
  tl("praveen", "decided", "Debounce rollup at 4s so bursts collapse to one synthesis");
  tl("praveen", "started", "Project rollup synthesizer");

  setMember("asha", "Asha", {
    headline: "Building the team grid + pending rail in the Next.js dashboard",
    goal: "Editorial light-theme dashboard, no kanban, living context per person",
    status: "blocked",
    working_on: JSON.stringify(["app/project/[id]/page.tsx", "globals.css"]),
  });
  tl("asha", "did", "Hero, goal editor, and team cards laid out");
  tl("asha", "blocked", "Needs the /api/stream SSE event shape finalized to wire live updates");

  setMember("ravi", "Ravi", {
    headline: "Exposed reins_context over MCP so any agent can pull shared state",
    goal: "MCP retrieval layer for cross-agent context",
    status: "active",
    working_on: JSON.stringify(["mcp.ts", "pipeline/reconcile.ts"]),
  });
  tl("ravi", "did", "reins_context / reins_pending / reins_member tools live over stdio");
  tl("ravi", "decided", "Render context as markdown so it drops straight into an agent prompt");

  upsertPending(PROJECT, "asha", "Document the /api/stream SSE event shape so live updates can be wired");
  upsertPending(PROJECT, "praveen", "Decide the rollup debounce window and whether leads can force a resync");
  upsertPending(PROJECT, "ravi", "Add a reins_claim write-tool so agents can claim pending work directly");

  saveRollup(PROJECT, {
    summary:
      "The team is converging on a working MVP. The distillation pipeline (triage → extract → reconcile) is functional and now feeding the dashboard; the rollup synthesizer and MCP retrieval are landing in parallel. One person is blocked on an interface detail.",
    alignment:
      "On track for the goal. All three workstreams (capture/distill, dashboard, and MCP retrieval) map directly to the MVP loop.",
    collisions: [
      { area: "pipeline/reconcile.ts", members: ["praveen", "ravi"], note: "Both edited the reconcile stage; coordinate before merge." },
    ],
    risks: [
      "Asha blocked on SSE event shape",
      "Rollup debounce window undecided",
    ],
  });

  console.log("Seeded a pre-distilled demo board (no LLM). Project:", PROJECT);
}

if (LOCAL) localOnly();
else viaServer().catch((e) => { console.error(e); process.exit(1); });
