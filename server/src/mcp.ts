import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import "./db.js";
import { env } from "./env.js";
import { projectSnapshot, projectsList } from "./state.js";
import { getProject, buildGoalsView, countPendingProposals, buildProfileView, resolveMember } from "./db.js";
import {
  buildScopedContextPack,
  renderContextPack,
  type ScopeOptions,
} from "./context-pack.js";

// Write tools go through the HTTP server so distillation + live SSE fire in the
// server process (the MCP server is a separate process sharing the same DB file).
const SERVER = (process.env.REINS_URL || `http://localhost:${env.port}`).replace(/\/$/, "");

async function send(method: string, path: string, body: unknown): Promise<{ ok: boolean; json?: any; error?: string }> {
  try {
    const res = await fetch(SERVER + path, {
      method,
      headers: { "content-type": "application/json", ...(env.ingestKey ? { "x-reins-key": env.ingestKey } : {}) },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    if (!res.ok) return { ok: false, error: `server returned ${res.status} (is the reins server running at ${SERVER}?)` };
    let json: any = {};
    try { json = raw ? JSON.parse(raw) : {}; } catch { /* non-json ok */ }
    return { ok: true, json };
  } catch {
    return { ok: false, error: `could not reach reins server at ${SERVER}` };
  }
}

async function post(path: string, body: unknown): Promise<string> {
  const r = await send("POST", path, body);
  return r.ok ? "ok" : `error: ${r.error}`;
}

/**
 * Reins MCP server — lets any teammate's agent READ the live shared context.
 * Run this as an MCP server in Claude Code / Cursor / etc:
 *   { "command": "tsx", "args": ["server/src/mcp.ts"], "cwd": "<repo>" }
 */
const server = new McpServer({ name: "reins", version: "0.1.0" });

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

/** Retrieve and render a project's shared context from the local DB. */
async function renderProject(id: string, scope: ScopeOptions = {}): Promise<string> {
  if (!getProject(id)) {
    return `No project "${id}". Known: ${projectsList().map((p) => p.id).join(", ") || "(none)"}`;
  }
  return renderContextPack(buildScopedContextPack(id, scope), { from: "local" });
}

server.tool(
  "reins_context",
  "Get the live shared context for a project: goal, team status, and pending work. Call this before starting work to know what teammates are doing. Optionally SCOPE retrieval to only what's relevant to your task: pass `member` to focus on one teammate, `query` to rank team + pending by relevance to a task description, and/or `limit` (approx token budget) to trim. The goal and status summary are always kept.",
  {
    project: z.string().describe("Project id"),
    member: z.string().optional().describe("Focus on this teammate (id or name): they rank first and survive trimming"),
    query: z.string().optional().describe("Task description; ranks teammates + pending work by relevance to it"),
    limit: z.number().int().positive().optional().describe("Approx token budget for the team + pending lists (chars/4); trims the rest"),
  },
  async ({ project, member, query, limit }) =>
    text(await renderProject(project, { member, query, limit }))
);

server.tool(
  "reins_projects",
  "List all projects Reins is tracking, with member and active counts.",
  {},
  async () => {
    const ps = projectsList();
    return text(
      ps.length
        ? ps.map((p) => `- ${p.id} — ${p.name} (${p.active}/${p.members} active) goal: ${p.goal || "—"}`).join("\n")
        : "No projects yet."
    );
  }
);

server.tool(
  "reins_member",
  "Get one teammate's detailed live context (goal, status, what they're on, recent timeline) in a project.",
  { project: z.string(), member: z.string() },
  async ({ project, member }) => {
    const s = projectSnapshot(project);
    const m = s?.members.find((x) => x.member === member || x.displayName === member);
    if (!m) return text(`No member "${member}" in "${project}".`);
    const tl = m.timeline.map((t) => `  - (${t.kind}) ${t.summary}`).join("\n");
    return text(
      `${m.displayName} [${m.status}]\nNow: ${m.headline}\nGoal: ${m.goal}\nOn: ${m.workingOn.join(", ") || "—"}\nRecent:\n${tl || "  (none)"}`
    );
  }
);

server.tool(
  "reins_pending",
  "List pending / up-for-grabs work in a project that a teammate could pick up.",
  { project: z.string() },
  async ({ project }) => {
    const s = projectSnapshot(project);
    if (!s) return text(`No project "${project}".`);
    const open = s.pending.filter((p: any) => p.status === "open");
    return text(
      open.length
        ? open.map((p: any) => `- [${p.id}] (from ${p.member}) ${p.text}`).join("\n")
        : "Nothing open right now."
    );
  }
);

server.tool(
  "reins_handoffs",
  "List handoffs / @mentions directed AT a teammate in a project — collisions, blockers, or direct asks they should act on. Check this for yourself before and during work.",
  { project: z.string(), member: z.string().describe("Whose incoming handoffs to list (you)") },
  async ({ project, member }) => {
    const s = projectSnapshot(project);
    const m = s?.members.find((x) => x.member === member || x.displayName === member);
    if (!m) return text(`No member "${member}" in "${project}".`);
    const hs = (m as any).handoffs ?? [];
    return text(
      hs.length
        ? hs.map((h: any) => `- [${h.id}] (${h.kind}${h.from ? ` from ${h.from}` : ""}) ${h.text} {${h.status}}`).join("\n")
        : "No open handoffs for you. Clear."
    );
  }
);

// ── Write tools (close the loop: agents can act, not just read) ──
server.tool(
  "reins_note",
  "Post a progress/intent note from your agent into a project's shared context. Use this to tell teammates what you're doing or just did. It gets distilled onto the live board.",
  {
    project: z.string(),
    member: z.string().describe("Who you are (e.g. your name or git email)"),
    text: z.string().describe("What you're doing / did / decided / are blocked on"),
    kind: z.enum(["intent", "progress", "summary"]).default("progress"),
  },
  async ({ project, member, text, kind }) => text2(await post("/api/ingest", { project, member, text, kind }))
);

server.tool(
  "reins_claim",
  "Claim a pending / up-for-grabs item in a project so teammates know you're on it. Get ids from reins_pending.",
  { project: z.string(), id: z.string(), by: z.string().describe("Who is claiming it") },
  async ({ project, id, by }) => text2(await post(`/api/pending/${id}/claim`, { project, by }))
);

server.tool(
  "reins_resolve",
  "Mark a pending item done in a project.",
  { project: z.string(), id: z.string() },
  async ({ project, id }) => text2(await post(`/api/pending/${id}/done`, { project }))
);

server.tool(
  "reins_handoff_ack",
  "Acknowledge or resolve a handoff directed at you (get ids from reins_handoffs). action: 'ack' = seen/on it, 'resolve' = done.",
  { project: z.string(), id: z.string(), action: z.enum(["ack", "resolve"]).default("ack") },
  async ({ project, id, action }) => text2(await post(`/api/handoffs/${id}/${action}`, { project }))
);

// ── Short-term goals ──
function renderGoals(project: string, memberFilter?: string): string {
  const view = buildGoalsView(project);
  const mark = (s: string) => (s === "done" ? "✓" : s === "blocked" ? "⊘" : "•");
  const fmt = (g: (typeof view)[number]) => {
    const p = g.scope === "team" ? g.rollup : g.progress;
    const items = g.items.map((i) => `    [${i.done ? "x" : " "}] ${i.text}  {item ${i.id}}`).join("\n");
    return `${mark(g.status)} ${g.title}  (${p.done}/${p.total}) {goal ${g.id}}${items ? `\n${items}` : ""}`;
  };
  const team = view.filter((g) => g.scope === "team");
  const indiv = view.filter((g) => g.scope === "individual" && (!memberFilter || g.member === memberFilter));
  const out: string[] = [];
  out.push("# Team goals\n" + (team.length ? team.map(fmt).join("\n") : "(none)"));
  out.push(
    `\n# ${memberFilter ? `${memberFilter}'s goals` : "Individual goals"}\n` +
      (indiv.length ? indiv.map((g) => `${g.member ? `(${g.member}) ` : ""}${fmt(g)}`).join("\n") : "(none)")
  );
  const pending = countPendingProposals(project);
  if (pending > 0) out.push(`\n(${pending} auto-tracked update${pending === 1 ? "" : "s"} awaiting confirmation in the dashboard)`);
  return out.join("\n");
}

server.tool(
  "reins_goals",
  "Read the short-term goals for a project: common TEAM goals and individual goals, each with a checklist and progress. Pass `member` to focus on one teammate's goals. Use the {goal …} / {item …} ids with reins_goal_check.",
  { project: z.string(), member: z.string().optional().describe("Focus on this teammate's individual goals") },
  async ({ project, member }) => {
    if (!getProject(project)) return text(`No project "${project}".`);
    return text(renderGoals(project, member));
  }
);

server.tool(
  "reins_goal_add",
  "Declare one of YOUR OWN short-term goals (with an optional checklist) in a project, so the team can see and track what you're about to do. Creates an individual goal for `member`. (Team/common goals are set by admins in the dashboard.)",
  {
    project: z.string(),
    member: z.string().describe("Who you are (id or name) — the goal is yours"),
    title: z.string().describe("The goal, one line"),
    items: z.array(z.string()).optional().describe("Optional checklist of concrete steps"),
  },
  async ({ project, member, title, items }) => {
    const r = await send("POST", `/api/projects/${project}/goals`, { scope: "individual", member, title, items });
    if (!r.ok) return text(`error: ${r.error}`);
    return text(`Added your goal "${title}"${items?.length ? ` with ${items.length} step(s)` : ""}. (goal ${r.json?.id})`);
  }
);

server.tool(
  "reins_goal_check",
  "Tick (or untick) a checklist item on a goal as you complete it. Get item ids from reins_goals ({item …}).",
  { item: z.string().describe("The item id from reins_goals"), done: z.boolean().default(true) },
  async ({ item, done }) => {
    const r = await send("PATCH", `/api/goal-items/${item}`, { done });
    return text(r.ok ? `Marked item ${done ? "done" : "not done"}.` : `error: ${r.error}`);
  }
);

// ── Taste profile (member "grain") ──
const TRAIT_LABEL: Record<string, string> = {
  tooling: "Tooling",
  quality: "Quality bar",
  communication: "Communication",
  concern: "Recurring concerns",
  workflow: "Workflow",
};

server.tool(
  "reins_profile",
  "Read a teammate's TASTE PROFILE in a project: their durable working grain (tooling, quality bar, communication style, recurring concerns, workflow) learned passively from their activity — not their raw prompts. Pull your own to recall how you like to work, or a teammate's to match their style. Great to read at the start of a task and graft into your working preferences.",
  { project: z.string(), member: z.string().describe("Whose profile (id or name) — yourself or a teammate") },
  async ({ project, member }) => {
    if (!getProject(project)) return text(`No project "${project}".`);
    const id = resolveMember(project, member) || member;
    const traits = buildProfileView(project, id);
    if (!traits.length) return text(`No taste profile yet for "${member}" — it builds up as they work.`);
    const byType = new Map<string, typeof traits>();
    for (const t of traits) {
      if (!byType.has(t.type)) byType.set(t.type, []);
      byType.get(t.type)!.push(t);
    }
    const out: string[] = [`# Taste profile — ${member}`];
    for (const type of Object.keys(TRAIT_LABEL)) {
      const ts = byType.get(type);
      if (!ts?.length) continue;
      out.push(`\n## ${TRAIT_LABEL[type]}`);
      for (const t of ts) out.push(`- ${t.statement}  (${t.level}, ${t.observations}×)`);
    }
    return text(out.join("\n"));
  }
);

function text2(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("reins MCP server ready (stdio)");
