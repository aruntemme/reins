import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import "./db.js";
import { env } from "./env.js";
import { projectSnapshot, projectsList } from "./state.js";
import { getProject, getRollup } from "./db.js";
import { buildContextPack, renderContextPack, type ContextPack } from "./context-pack.js";
import { getSnapshot, storageExplorerUrl } from "./llm/og-storage.js";
import { syncPush, syncPull } from "./sync.js";

// Write tools go through the HTTP server so distillation + live SSE fire in the
// server process (the MCP server is a separate process sharing the same DB file).
const SERVER = (process.env.REINS_URL || `http://localhost:${env.port}`).replace(/\/$/, "");

async function post(path: string, body: unknown): Promise<string> {
  try {
    const res = await fetch(SERVER + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(env.ingestKey ? { "x-reins-key": env.ingestKey } : {}) },
      body: JSON.stringify(body),
    });
    if (!res.ok) return `error: server returned ${res.status} (is the reins server running at ${SERVER}?)`;
    return "ok";
  } catch {
    return `error: could not reach reins server at ${SERVER}`;
  }
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

/**
 * Retrieve a project's shared context. When the project has a context pack
 * anchored on 0G Storage, we fetch + verify it straight from 0G Storage (the
 * pack is content-addressed by Merkle root hash, so a successful fetch IS the
 * integrity check). We fall back to the local DB only if Storage is off or the
 * project hasn't been distilled yet.
 */
async function renderProject(id: string): Promise<string> {
  if (!getProject(id)) {
    return `No project "${id}". Known: ${projectsList().map((p) => p.id).join(", ") || "(none)"}`;
  }

  const rollup: any = getRollup(id);
  const rootHash: string = rollup?.root_hash || "";

  if (env.og.storageEnabled && rootHash) {
    try {
      const pack = await getSnapshot<ContextPack>(rootHash);
      return renderContextPack(pack, {
        from: "0g-storage",
        rootHash,
        url: storageExplorerUrl(rootHash),
      });
    } catch (e: any) {
      // 0G Storage unreachable — fall back to local but say so plainly.
      return renderContextPack(buildContextPack(id), {
        from: "local",
        note: `could not reach 0G Storage for root ${rootHash}: ${e?.message ?? e}`,
      });
    }
  }

  return renderContextPack(buildContextPack(id), { from: "local" });
}

server.tool(
  "reins_context",
  "Get the live shared context for a project: goal, team status, and pending work. Call this before starting work to know what teammates are doing.",
  { project: z.string().describe("Project id") },
  async ({ project }) => text(await renderProject(project))
);

server.tool(
  "reins_pull_context",
  "Reconstruct a shared-context snapshot from a 0G Storage root hash ALONE — no database needed. Use this to pull a teammate's or another team's context when all you have is the hash: the pack is fetched and Merkle-verified straight from 0G Storage.",
  { rootHash: z.string().describe("0G Storage Merkle root hash of a context pack") },
  async ({ rootHash }) => {
    try {
      const pack = await getSnapshot<ContextPack>(rootHash);
      return text(
        renderContextPack(pack, { from: "0g-storage", rootHash, url: storageExplorerUrl(rootHash) })
      );
    } catch (e: any) {
      return text(`Could not pull context from 0G Storage for root ${rootHash}: ${e?.message ?? e}`);
    }
  }
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

// ── Cross-instance sync over 0G Storage ──
server.tool(
  "reins_sync_push",
  "Push a project's current shared-context pack to 0G Storage and get back its Merkle root hash. Share that hash with another team/instance so they can pull this exact, verifiable context with reins_sync_pull (no DB access needed).",
  { project: z.string().describe("Project id to push") },
  async ({ project }) => {
    if (!getProject(project)) return text(`No project "${project}".`);
    try {
      const { rootHash, txHash } = await syncPush(project);
      return text(
        `Pushed "${project}" to 0G Storage.\nroot hash: ${rootHash}\nupload tx: ${txHash}\n${storageExplorerUrl(rootHash)}\n\nPull it elsewhere with: reins_sync_pull { rootHash: "${rootHash}" }`
      );
    } catch (e: any) {
      return text(`Could not push "${project}" to 0G Storage: ${e?.message ?? e}`);
    }
  }
);

server.tool(
  "reins_sync_pull",
  "Pull a shared-context pack from 0G Storage by its Merkle root hash ALONE and merge it into this instance. Use to import a teammate's or another team's context. Merge is idempotent: pulling the same hash twice never duplicates anything.",
  {
    rootHash: z.string().describe("0G Storage Merkle root hash of a context pack"),
    project: z.string().optional().describe("Local project id to merge into (defaults to the pack's own id)"),
  },
  async ({ rootHash, project }) => {
    try {
      const r = await syncPull(rootHash, project);
      return text(
        `Merged context from 0G Storage (root ${rootHash}) into "${r.project}": ${r.members} member(s), ${r.pending} pending item(s).`
      );
    } catch (e: any) {
      return text(`Could not pull context from 0G Storage for root ${rootHash}: ${e?.message ?? e}`);
    }
  }
);

function text2(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("reins MCP server ready (stdio)");
