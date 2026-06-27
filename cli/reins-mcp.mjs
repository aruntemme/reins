/**
 * reins-mcp — an HTTP-backed MCP server for Reins, so ANY teammate can give their
 * agent read/write access to the shared board over the network (no local DB, no
 * repo clone). Speaks the MCP stdio protocol (newline-delimited JSON-RPC 2.0)
 * directly, so it stays dependency-free like the rest of reins-hook.
 *
 *   npx reins-hook mcp --url https://your-reins --token rk_access_…
 *
 * Reads + most writes authenticate with the ACCESS token (Authorization: Bearer).
 * Posting notes (reins_note) needs an INGEST token; pass --ingest-token to enable
 * it. Everything goes through the public API, the same one the dashboard uses.
 *
 * stdout carries ONLY protocol messages; all diagnostics go to stderr.
 */
import readline from "node:readline";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
let VERSION = "0.0.0";
try { VERSION = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8")).version || VERSION; } catch { /* ok */ }

export async function runMcp(opts) {
  const base = (opts.url || "http://localhost:4319").replace(/\/$/, "");
  const token = opts.token || opts.key || "";          // access token (reads + writes)
  const ingestKey = opts.ingestToken || opts.ingest || ""; // ingest token (reins_note only)
  const log = (...a) => process.stderr.write(`[reins-mcp] ${a.join(" ")}\n`);

  async function api(method, path, body, { ingest = false } = {}) {
    const headers = { "content-type": "application/json" };
    if (ingest) { if (ingestKey) headers["x-reins-key"] = ingestKey; }
    else if (token) headers["authorization"] = `Bearer ${token}`;
    const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (!res.ok) {
      const hint = res.status === 401 ? " (check --token / --url, and that this access token is valid)" : "";
      throw new Error(`${res.status} ${method} ${path}${hint}: ${text.slice(0, 200)}`);
    }
    return text ? JSON.parse(text) : {};
  }

  // ── rendering helpers (concise text the model reads) ──
  const ago = (ts) => {
    const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  };
  const TRAIT_LABEL = { tooling: "Tooling", quality: "Quality bar", communication: "Communication", concern: "Recurring concerns", workflow: "Workflow" };
  const findMember = (snap, who) => snap?.members?.find((x) => x.member === who || x.displayName === who);

  function renderContext(snap, focus) {
    if (!snap) return "Project not found.";
    const out = [`# ${snap.name || snap.id}`, `Goal: ${snap.goal || "—"}`];
    if (snap.rollup?.summary) out.push(`\nStatus: ${snap.rollup.summary}`);
    let members = snap.members || [];
    if (focus) { const m = findMember(snap, focus); members = m ? [m] : []; }
    out.push("\n## Team");
    out.push(members.length
      ? members.map((m) => `- ${m.displayName} [${m.displayStatus || m.status}] — ${m.headline || "…"}${m.workingOn?.length ? ` (on: ${m.workingOn.join(", ")})` : ""}`).join("\n")
      : "  (none)");
    const open = (snap.pending || []).filter((p) => p.status !== "done");
    out.push("\n## Pending / up for grabs");
    out.push(open.length ? open.map((p) => `- [${p.id}] (from ${p.member}) ${p.text}`).join("\n") : "  (nothing open)");
    return out.join("\n");
  }

  // ── tool definitions ──
  const S = (props, required = []) => ({ type: "object", properties: props, required });
  const str = (description) => ({ type: "string", description });
  const tools = [
    {
      name: "reins_context",
      description: "Get the live shared context for a project: goal, team status, and pending work. Call this before starting work. Optionally pass `member` to focus on one teammate.",
      inputSchema: S({ project: str("Project id"), member: str("Optional: focus on one teammate (id or name)") }, ["project"]),
      run: async ({ project, member }) => renderContext(await api("GET", `/api/projects/${encodeURIComponent(project)}`), member),
    },
    {
      name: "reins_projects",
      description: "List the projects Reins is tracking, with member and active counts.",
      inputSchema: S({}),
      run: async () => {
        const { projects = [] } = await api("GET", "/api/projects");
        return projects.length ? projects.map((p) => `- ${p.id} — ${p.name} (${p.active}/${p.members} active) goal: ${p.goal || "—"}`).join("\n") : "No projects yet.";
      },
    },
    {
      name: "reins_member",
      description: "Get one teammate's detailed live context (goal, status, what they're on, recent timeline) in a project.",
      inputSchema: S({ project: str("Project id"), member: str("Teammate id or name") }, ["project", "member"]),
      run: async ({ project, member }) => {
        const m = await api("GET", `/api/projects/${encodeURIComponent(project)}/members/${encodeURIComponent(member)}`);
        const tl = (m.timeline || []).slice(0, 12).map((t) => `  - (${t.kind}) ${t.summary}`).join("\n");
        return `${m.displayName} [${m.displayStatus || m.status}]\nNow: ${m.headline || "—"}\nGoal: ${m.goal || "—"}\nOn: ${(m.workingOn || []).join(", ") || "—"}\nRecent:\n${tl || "  (none)"}`;
      },
    },
    {
      name: "reins_pending",
      description: "List pending / up-for-grabs work in a project a teammate could pick up.",
      inputSchema: S({ project: str("Project id") }, ["project"]),
      run: async ({ project }) => {
        const snap = await api("GET", `/api/projects/${encodeURIComponent(project)}`);
        const open = (snap.pending || []).filter((p) => p.status === "open");
        return open.length ? open.map((p) => `- [${p.id}] (from ${p.member}) ${p.text}`).join("\n") : "Nothing open right now.";
      },
    },
    {
      name: "reins_handoffs",
      description: "List handoffs / @mentions directed AT a teammate in a project — collisions, blockers, or direct asks they should act on.",
      inputSchema: S({ project: str("Project id"), member: str("Whose incoming handoffs (you)") }, ["project", "member"]),
      run: async ({ project, member }) => {
        const m = await api("GET", `/api/projects/${encodeURIComponent(project)}/members/${encodeURIComponent(member)}`);
        const hs = m.handoffs || [];
        return hs.length ? hs.map((h) => `- [${h.id}] (${h.kind}${h.from ? ` from ${h.from}` : ""}) ${h.text} {${h.status}}`).join("\n") : "No open handoffs for you. Clear.";
      },
    },
    {
      name: "reins_goals",
      description: "Read the short-term goals for a project: common TEAM goals and individual goals, each with a checklist and progress. Pass `member` to focus on one teammate.",
      inputSchema: S({ project: str("Project id"), member: str("Optional: focus on one teammate's goals") }, ["project"]),
      run: async ({ project, member }) => {
        const { goals = [] } = await api("GET", `/api/projects/${encodeURIComponent(project)}/goals`);
        const mark = (g) => (g.status === "done" ? "✓" : g.status === "blocked" ? "⊘" : "•");
        const fmt = (g) => {
          const p = g.scope === "team" ? g.rollup : g.progress;
          const items = (g.items || []).map((i) => `    [${i.done ? "x" : " "}] ${i.text}  {item ${i.id}}`).join("\n");
          return `${mark(g)} ${g.title}  (${p?.done ?? 0}/${p?.total ?? 0}) {goal ${g.id}}${items ? `\n${items}` : ""}`;
        };
        const team = goals.filter((g) => g.scope === "team");
        const indiv = goals.filter((g) => g.scope === "individual" && (!member || g.member === member));
        return [
          "# Team goals\n" + (team.length ? team.map(fmt).join("\n") : "(none)"),
          `\n# ${member ? `${member}'s goals` : "Individual goals"}\n` + (indiv.length ? indiv.map((g) => `${g.member ? `(${g.member}) ` : ""}${fmt(g)}`).join("\n") : "(none)"),
        ].join("\n");
      },
    },
    {
      name: "reins_profile",
      description: "Read a teammate's TASTE PROFILE: their durable working grain (tooling, quality bar, communication, recurring concerns, workflow), learned from activity. Read your own to recall how you work, or a teammate's to match their style.",
      inputSchema: S({ project: str("Project id"), member: str("Whose profile — you or a teammate") }, ["project", "member"]),
      run: async ({ project, member }) => {
        const m = await api("GET", `/api/projects/${encodeURIComponent(project)}/members/${encodeURIComponent(member)}`);
        const traits = m.profile || [];
        if (!traits.length) return `No taste profile yet for "${member}" — it builds up as they work.`;
        const byType = {};
        for (const t of traits) (byType[t.type] ||= []).push(t);
        const out = [`# Taste profile — ${m.displayName || member}`];
        for (const type of Object.keys(TRAIT_LABEL)) {
          const ts = byType[type]; if (!ts?.length) continue;
          out.push(`\n## ${TRAIT_LABEL[type]}`);
          for (const t of ts) out.push(`- ${t.statement}  (${t.level}, ${t.observations}×)`);
        }
        return out.join("\n");
      },
    },
    {
      name: "reins_claim",
      description: "Claim a pending item so teammates know you're on it. Get ids from reins_pending.",
      inputSchema: S({ project: str("Project id"), id: str("Pending item id"), by: str("Who is claiming it") }, ["project", "id", "by"]),
      run: async ({ project, id, by }) => { await api("POST", `/api/pending/${encodeURIComponent(id)}/claim`, { project, by }); return "Claimed."; },
    },
    {
      name: "reins_resolve",
      description: "Mark a pending item done in a project.",
      inputSchema: S({ project: str("Project id"), id: str("Pending item id") }, ["project", "id"]),
      run: async ({ project, id }) => { await api("POST", `/api/pending/${encodeURIComponent(id)}/done`, { project }); return "Marked done."; },
    },
    {
      name: "reins_handoff_ack",
      description: "Acknowledge ('ack' = seen/on it) or 'resolve' (done) a handoff directed at you. Get ids from reins_handoffs.",
      inputSchema: S({ project: str("Project id"), id: str("Handoff id"), action: { type: "string", enum: ["ack", "resolve"], description: "ack or resolve" } }, ["project", "id"]),
      run: async ({ project, id, action }) => { await api("POST", `/api/handoffs/${encodeURIComponent(id)}/${action === "resolve" ? "resolve" : "ack"}`, { project }); return "Done."; },
    },
    {
      name: "reins_goal_add",
      description: "Declare one of YOUR OWN short-term goals (with an optional checklist) so the team can track what you're about to do. Creates an individual goal for `member`.",
      inputSchema: S({ project: str("Project id"), member: str("Who you are (id or name)"), title: str("The goal, one line"), items: { type: "array", items: { type: "string" }, description: "Optional checklist of steps" } }, ["project", "member", "title"]),
      run: async ({ project, member, title, items }) => {
        const r = await api("POST", `/api/projects/${encodeURIComponent(project)}/goals`, { scope: "individual", member, title, items });
        return `Added your goal "${title}"${items?.length ? ` with ${items.length} step(s)` : ""}. (goal ${r.id})`;
      },
    },
    {
      name: "reins_goal_check",
      description: "Tick (or untick) a checklist item on a goal as you complete it. Get item ids from reins_goals ({item …}).",
      inputSchema: S({ item: str("Item id from reins_goals"), done: { type: "boolean", description: "true to tick, false to untick (default true)" } }, ["item"]),
      run: async ({ item, done = true }) => { await api("PATCH", `/api/goal-items/${encodeURIComponent(item)}`, { done }); return `Marked item ${done ? "done" : "not done"}.`; },
    },
    {
      name: "reins_note",
      description: "Post a progress/intent note from your agent into a project's shared context. Tells teammates what you're doing or just did; it gets distilled onto the board. Requires an ingest token (start reins-mcp with --ingest-token).",
      inputSchema: S({ project: str("Project id"), member: str("Who you are"), text: str("What you're doing / did / decided / are blocked on"), kind: { type: "string", enum: ["intent", "progress", "summary"], description: "default progress" } }, ["project", "member", "text"]),
      run: async ({ project, member, text, kind }) => {
        if (!ingestKey) throw new Error("posting notes needs an ingest token — restart reins-mcp with --ingest-token <rk_ingest_…>");
        await api("POST", "/api/ingest", { project, member, text, kind: kind || "progress" }, { ingest: true });
        return "Posted to the board.";
      },
    },
  ];
  const byName = new Map(tools.map((t) => [t.name, t]));

  // ── JSON-RPC 2.0 over stdio (newline-delimited) ──
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
  const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
  const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

  async function handle(msg) {
    const { id, method, params } = msg;
    const isRequest = id !== undefined && id !== null;
    try {
      if (method === "initialize") {
        const pv = typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18";
        return reply(id, { protocolVersion: pv, capabilities: { tools: {} }, serverInfo: { name: "reins", version: VERSION } });
      }
      if (method === "tools/list") return reply(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      if (method === "tools/call") {
        const tool = byName.get(params?.name);
        if (!tool) return reply(id, { content: [{ type: "text", text: `Unknown tool: ${params?.name}` }], isError: true });
        try {
          const text = await tool.run(params.arguments || {});
          return reply(id, { content: [{ type: "text", text: String(text) }], isError: false });
        } catch (e) {
          return reply(id, { content: [{ type: "text", text: `error: ${e?.message ?? e}` }], isError: true });
        }
      }
      if (method === "ping") return reply(id, {});
      // notifications/initialized and any other notification: no response.
      if (!isRequest) return;
      return fail(id, -32601, `Method not found: ${method}`);
    } catch (e) {
      if (isRequest) fail(id, -32603, `Internal error: ${e?.message ?? e}`);
    }
  }

  log(`ready → ${base} (${tools.length} tools${ingestKey ? ", notes enabled" : ", read+act"})`);
  const rl = readline.createInterface({ input: process.stdin });
  for await (const line of rl) {
    const s = line.trim();
    if (!s) continue;
    let msg;
    try { msg = JSON.parse(s); } catch { continue; } // ignore non-JSON noise
    await handle(msg);
  }
}
