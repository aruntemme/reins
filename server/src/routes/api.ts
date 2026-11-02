import { Router } from "express";
import { z } from "zod";
import { ingest, accepting } from "../pipeline/index.js";
import { runRollup } from "../pipeline/rollup.js";
import { projectSnapshot, projectsList, memberDetail } from "../state.js";
import { setGoal, setPendingStatus, claimPending, getProject, setHandoffStatus, resolveHandoffs, listPending, ensureProject, projectWorkspace } from "../db.js";
import {
  buildGoalsView, createGoal, getGoal, updateGoal, deleteGoal,
  addGoalItem, updateGoalItem, deleteGoalItem, goalItemGoal, ensureMember,
  listGoalProposals, getGoalProposal, acceptGoalProposal, dismissGoalProposal,
  getTrait, updateTrait, dismissTrait, TRAIT_TYPES,
} from "../db.js";
import type { GoalRow, TraitRow, TraitType } from "../db.js";
import { bus } from "../bus.js";
import { llmConfigured, activeModel } from "../llm/client.js";
import {
  listProviders, createProvider, updateProvider, deleteProvider, setActiveProvider,
} from "../db.js";
import { env, envLlmConfigured } from "../env.js";
import type { Request, Response } from "express";
import {
  requireIngest, requireViewer, requireAdmin, authorizeProject, isWorkspaceAdmin,
  asyncHandler, counterMap, overLimit,
} from "../middleware.js";
import { buildScopedContextPack, renderContextPack, handoffConventions } from "../context-pack.js";
import { reconcileCollisions } from "../collisions.js";
import {
  reopenHandoff, createHandoff, createDirective, clearDirective, activeDirectives,
  createAssignment, clearAssignment, activeAssignments, resolveMember, listMembers,
  workspaceHidesBranches, setWorkspaceHidesBranches,
} from "../db.js";

export const api = Router();

// ── Ingest (hooks / agents) ───────────────────────────────────
const IngestBody = z.object({
  project: z.string().min(1),
  member: z.string().min(1),
  displayName: z.string().optional(),
  kind: z.enum(["intent", "progress", "summary"]).default("progress"),
  text: z.string().min(1),
  session: z.string().optional(),
  meta: z.unknown().optional(),
  source: z.string().max(40).optional(), // capturing agent harness (default claude-code)
});

// Per-workspace rate limits (fixed windows, in memory). Generous for real use —
// a busy hook sends a couple of events per prompt — but they bound what one
// tenant (or a leaked token) can make the server store and pay the LLM for.
const INGEST_MAX_PER_MIN = 300;
const ROLLUP_MAX_PER_MIN = 6;
const ingestHits = counterMap();
const rollupHits = counterMap();

api.post("/ingest", requireIngest, asyncHandler(async (req, res) => {
  // Back-compat single-key mode (only when full auth is off).
  if (!env.authEnabled && env.ingestKey && req.header("x-reins-key") !== env.ingestKey) {
    return res.status(401).json({ error: "bad key" });
  }
  if (!accepting()) return res.status(503).json({ error: "server is shutting down, retry shortly" });
  const parsed = IngestBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
  // Project ids are global and the hook defaults to the folder name, so another
  // workspace may already own this id. Never write into it: refuse, and say how
  // to fix it, instead of silently landing events on someone else's board.
  const ws = req.workspaceId ?? "default";
  const owner = projectWorkspace(parsed.data.project);
  if (env.authEnabled && owner && owner !== ws) {
    return res.status(403).json({
      error: `project "${parsed.data.project}" belongs to another workspace — use a different project id (reins-hook install --project <id>)`,
    });
  }
  if (overLimit(ingestHits, ws, INGEST_MAX_PER_MIN, 60_000)) {
    return res.status(429).json({ error: "ingest rate limit reached for this workspace, slow down" });
  }
  const { eventId } = await ingest({ ...parsed.data, workspaceId: ws });
  res.json({ ok: true, eventId });
}));

// ── Read ──────────────────────────────────────────────────────
api.get("/projects", requireViewer, (req, res) => {
  const ws = env.authEnabled ? req.workspaceId : undefined;
  res.json({ projects: projectsList(ws), llm: llmConfigured(), auth: env.authEnabled });
});

api.get("/projects/:id", requireViewer, (req, res) => {
  if (!authorizeProject(req, res, req.params.id!)) return;
  const snap = projectSnapshot(req.params.id!);
  if (!snap) return res.status(404).json({ error: "not found" });
  res.json(snap);
});

// Scoped, rendered shared context — the same text the local MCP's reins_context
// returns (goal, status, collisions, risks, team, pending), optionally focused on
// a member, ranked by a task query, and trimmed to a token budget. Lets the HTTP
// MCP give remote agents the same scoping without duplicating the logic.
api.get("/projects/:id/context", requireViewer, (req, res) => {
  if (!authorizeProject(req, res, req.params.id!)) return;
  if (!getProject(req.params.id!)) return res.status(404).json({ error: "not found" });
  const q = z
    .object({
      member: z.string().trim().max(120).optional(),
      query: z.string().trim().max(500).optional(),
      limit: z.coerce.number().int().positive().max(100_000).optional(),
    })
    .safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: q.error.issues });
  res.json({ context: renderContextPack(buildScopedContextPack(req.params.id!, q.data)) });
});

api.get("/projects/:id/members/:member", requireViewer, (req, res) => {
  if (!authorizeProject(req, res, req.params.id!)) return;
  const detail = memberDetail(req.params.id!, req.params.member!);
  if (!detail) return res.status(404).json({ error: "not found" });
  res.json(detail);
});

// Open pending items for a project — the queue an autonomous agent watches.
// Returns only status 'open' (unclaimed) so a claimer never double-claims.
api.get("/projects/:id/pending", requireViewer, (req, res) => {
  if (!authorizeProject(req, res, req.params.id!)) return;
  if (!getProject(req.params.id!)) return res.status(404).json({ error: "not found" });
  const pending = listPending(req.params.id!)
    .filter((p) => p.status === "open")
    .map((p) => ({
      id: p.id,
      member: p.member,
      text: p.text,
      status: p.status,
      claimedBy: p.claimed_by,
      createdAt: p.created_at,
    }));
  res.json({ pending });
});

// Create a project explicitly from the dashboard, scoped to the active workspace.
// (Projects are usually auto-created on first ingest; this lets a human pre-create
// one without sending an event.)
const PROJECT_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/; // lowercase slug, dash-separated
api.post("/projects", requireViewer, (req, res) => {
  const body = z.object({ id: z.string(), name: z.string().trim().min(1).max(80) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues });
  const id = body.data.id.trim().toLowerCase();
  if (!PROJECT_SLUG.test(id)) {
    return res.status(400).json({ error: "id must be a slug (lowercase letters, numbers, dashes)" });
  }
  const ws = env.authEnabled ? req.workspaceId! : "default";
  // A project id is global; if it already lives in another workspace, refuse so we
  // never silently rebind or expose it across tenants.
  const owner = projectWorkspace(id);
  if (owner && owner !== ws) {
    return res.status(409).json({ error: "a project with that id already exists" });
  }
  ensureProject(id, body.data.name, ws);
  const p = getProject(id);
  res.json({
    ok: true,
    project: { id: p.id, name: p.name, goal: p.goal ?? null, members: 0, active: 0, updatedAt: p.updated_at },
  });
});

// ── Mutations from the dashboard ──────────────────────────────
api.put("/projects/:id/goal", requireViewer, (req, res) => {
  if (!authorizeProject(req, res, req.params.id!)) return;
  const goal = z.object({ goal: z.string(), by: z.string().optional() }).safeParse(req.body);
  if (!goal.success) return res.status(400).json({ error: goal.error.issues });
  setGoal(req.params.id!, goal.data.goal, goal.data.by);
  bus.emitChange({ type: "goal.updated", project: req.params.id! });
  res.json({ ok: true });
});

api.post("/pending/:id/claim", requireViewer, (req, res) => {
  const body = z.object({ by: z.string(), project: z.string() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues });
  if (!authorizeProject(req, res, body.data.project)) return;
  // Atomic: only an OPEN item in this project can be claimed, so two claimers
  // racing (or an id from another project) can't both "win".
  if (!claimPending(body.data.project, req.params.id!, body.data.by)) {
    return res.status(409).json({ error: "that item is no longer open (already claimed, done, or not in this project)" });
  }
  bus.emitChange({ type: "pending.changed", project: body.data.project });
  res.json({ ok: true });
});

api.post("/pending/:id/done", requireViewer, (req, res) => {
  const body = z.object({ project: z.string() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues });
  if (!authorizeProject(req, res, body.data.project)) return;
  if (!setPendingStatus(body.data.project, req.params.id!, "done")) return res.status(404).json({ error: "not found" });
  bus.emitChange({ type: "pending.changed", project: body.data.project });
  reconcileCollisions(body.data.project); // a blocker waiting on this item can settle now
  res.json({ ok: true });
});

api.post("/handoffs/:id/:action", requireViewer, (req, res) => {
  const { action } = req.params;
  if (action !== "ack" && action !== "resolve" && action !== "reopen") return res.status(400).json({ error: "bad action" });
  const body = z.object({ project: z.string() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues });
  if (!authorizeProject(req, res, body.data.project)) return;
  // Reopen applies only to an auto-closed handoff, and stops the same check from
  // closing it again for the same reason.
  const ok =
    action === "reopen"
      ? reopenHandoff(body.data.project, req.params.id!)
      : setHandoffStatus(body.data.project, req.params.id!, action === "ack" ? "ack" : "resolved") > 0;
  if (!ok) return res.status(404).json({ error: action === "reopen" ? "not an auto-closed handoff in this project" : "not found" });
  bus.emitChange({ type: "handoff.changed", project: body.data.project });
  res.json({ ok: true });
});

// Bulk-clear a member's incoming handoffs, optionally just one kind (respects an
// active filter in the UI). Same authority as a single resolve: any viewer of the
// project can clear what's directed at this member.
api.post("/projects/:id/handoffs/resolve", requireViewer, (req, res) => {
  if (!authorizeProject(req, res, req.params.id!)) return;
  const body = z
    .object({ member: z.string().min(1), kind: z.enum(["mention", "collision", "blocker", "fyi", "assignment"]).optional() })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues });
  const resolved = resolveHandoffs(req.params.id!, body.data);
  if (resolved > 0) bus.emitChange({ type: "handoff.changed", project: req.params.id! });
  res.json({ ok: true, resolved });
});

api.post("/projects/:id/rollup", requireViewer, asyncHandler(async (req, res) => {
  if (!authorizeProject(req, res, req.params.id!)) return;
  if (!getProject(req.params.id!)) return res.status(404).json({ error: "not found" });
  if (overLimit(rollupHits, req.workspaceId ?? "default", ROLLUP_MAX_PER_MIN, 60_000)) {
    return res.status(429).json({ error: "too many resyncs, wait a minute and try again" });
  }
  try {
    await runRollup(req.params.id!);
  } catch (e: any) {
    // A bad provider key / unreachable model is the caller's to fix — report it.
    console.error("[rollup]", req.params.id, e?.message ?? e);
    return res.status(502).json({ error: `rollup failed: ${e?.message ?? "model provider error"}` });
  }
  res.json({ ok: true, rollup: projectSnapshot(req.params.id!)?.rollup ?? null });
}));

// ── Short-term goals (declared layer beneath the project goal) ────
// Common (team) goals are admin-authored; individual goals are open to any
// teammate. Everyone in the workspace can read. Authorization is by the goal's
// project, like every other read/write here.

/** Resolve + authorize a goal: 404 if missing, tenant-checked, and team goals
 *  require admin. Returns the goal or null (and responds) on failure. */
function accessGoal(req: Request, res: Response, goal: GoalRow | undefined): GoalRow | null {
  if (!goal) { res.status(404).json({ error: "not found" }); return null; }
  if (!authorizeProject(req, res, goal.project)) return null;
  if (goal.scope === "team") {
    if (!isWorkspaceAdmin(req)) {
      res.status(403).json({ error: "owner or admin role required for a team goal" });
      return null;
    }
  } else {
    // Individual goals belong to one teammate — only they act on them. A token
    // session (no userId) is a trusted machine credential (e.g. an agent over
    // MCP declaring/ticking its own goals) and is allowed through.
    if (req.userId && req.member !== goal.member) {
      res.status(403).json({ error: "this goal belongs to another teammate" });
      return null;
    }
  }
  return goal;
}

api.get("/projects/:id/goals", requireViewer, (req, res) => {
  if (!authorizeProject(req, res, req.params.id!)) return;
  res.json({ goals: buildGoalsView(req.params.id!) });
});

const GoalCreate = z.object({
  scope: z.enum(["team", "individual"]),
  title: z.string().trim().min(1).max(200),
  member: z.string().trim().min(1).max(120).optional(),
  parentId: z.string().optional(),
  createdBy: z.string().trim().max(120).optional(),
  items: z.array(z.string().trim().min(1).max(300)).max(50).optional(),
});
api.post("/projects/:id/goals", requireViewer, (req, res) => {
  if (!authorizeProject(req, res, req.params.id!)) return;
  const body = GoalCreate.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues });
  const { scope, title, member, parentId, createdBy, items } = body.data;
  if (scope === "team" && !isWorkspaceAdmin(req)) {
    return res.status(403).json({ error: "owner or admin role required to add a team goal" });
  }
  // A logged-in human can only create their OWN individual goals (their effective
  // member); a token session (agent) declares whatever member it carries.
  const goalMember = scope === "individual" ? (req.userId ? req.member : member) : null;
  if (scope === "individual" && !goalMember) {
    return res.status(400).json({ error: "an individual goal requires a member identity" });
  }
  if (parentId) {
    const parent = getGoal(parentId);
    if (!parent || parent.project !== req.params.id || parent.scope !== "team") {
      return res.status(400).json({ error: "parentId must be a team goal in this project" });
    }
  }
  if (goalMember) ensureMember(req.params.id!, goalMember);
  const id = createGoal({
    project: req.params.id!, scope, member: goalMember,
    parentId: parentId ?? null, title, createdBy: createdBy ?? goalMember ?? null,
  });
  for (const text of items ?? []) addGoalItem({ goalId: id, text });
  bus.emitChange({ type: "goals.changed", project: req.params.id! });
  res.json({ ok: true, id });
});

api.patch("/goals/:goalId", requireViewer, (req, res) => {
  const goal = accessGoal(req, res, getGoal(req.params.goalId!));
  if (!goal) return;
  const body = z
    .object({ title: z.string().trim().min(1).max(200).optional(), blocked: z.boolean().optional(), parentId: z.string().nullable().optional() })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues });
  updateGoal(goal.id, body.data);
  bus.emitChange({ type: "goals.changed", project: goal.project });
  res.json({ ok: true });
});

api.delete("/goals/:goalId", requireViewer, (req, res) => {
  const goal = accessGoal(req, res, getGoal(req.params.goalId!));
  if (!goal) return;
  deleteGoal(goal.id);
  bus.emitChange({ type: "goals.changed", project: goal.project });
  res.json({ ok: true });
});

api.post("/goals/:goalId/items", requireViewer, (req, res) => {
  const goal = accessGoal(req, res, getGoal(req.params.goalId!));
  if (!goal) return;
  const body = z.object({ text: z.string().trim().min(1).max(300) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues });
  const id = addGoalItem({ goalId: goal.id, text: body.data.text });
  bus.emitChange({ type: "goals.changed", project: goal.project });
  res.json({ ok: true, id });
});

api.patch("/goal-items/:itemId", requireViewer, (req, res) => {
  const goal = accessGoal(req, res, goalItemGoal(req.params.itemId!));
  if (!goal) return;
  const body = z.object({ text: z.string().trim().min(1).max(300).optional(), done: z.boolean().optional() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues });
  updateGoalItem(req.params.itemId!, body.data);
  bus.emitChange({ type: "goals.changed", project: goal.project });
  res.json({ ok: true });
});

api.delete("/goal-items/:itemId", requireViewer, (req, res) => {
  const goal = accessGoal(req, res, goalItemGoal(req.params.itemId!));
  if (!goal) return;
  deleteGoalItem(req.params.itemId!);
  bus.emitChange({ type: "goals.changed", project: goal.project });
  res.json({ ok: true });
});

// ── Goal auto-tracking proposals (Phase 2) ───────────────────
// The pipeline files proposals; the owner accepts or dismisses. Same authority
// as editing the underlying goal (team goals need owner/admin).
api.get("/projects/:id/goal-proposals", requireViewer, (req, res) => {
  if (!authorizeProject(req, res, req.params.id!)) return;
  // Only what the caller can act on: team-goal proposals to admins, an individual
  // goal's proposals to that teammate. Avoids surfacing a person's private goal
  // tracking to the rest of the team.
  const admin = isWorkspaceAdmin(req);
  const proposals = listGoalProposals(req.params.id!).filter((p) =>
    p.scope === "team" ? admin : !!req.userId && p.member === req.member
  );
  res.json({ proposals });
});

function accessProposalGoal(req: Request, res: Response, proposalId: string): { goal: GoalRow } | null {
  const p = getGoalProposal(proposalId);
  if (!p || p.status !== "pending") { res.status(404).json({ error: "not found" }); return null; }
  const goal = accessGoal(req, res, getGoal(p.goal_id));
  if (!goal) return null;
  return { goal };
}

api.post("/goal-proposals/:id/accept", requireViewer, (req, res) => {
  const ctx = accessProposalGoal(req, res, req.params.id!);
  if (!ctx) return;
  acceptGoalProposal(req.params.id!);
  bus.emitChange({ type: "goals.changed", project: ctx.goal.project });
  res.json({ ok: true });
});

api.post("/goal-proposals/:id/dismiss", requireViewer, (req, res) => {
  const ctx = accessProposalGoal(req, res, req.params.id!);
  if (!ctx) return;
  dismissGoalProposal(req.params.id!);
  bus.emitChange({ type: "goals.changed", project: ctx.goal.project });
  res.json({ ok: true });
});

// ── Taste profile (member "grain") ────────────────────────────
// The profile (an abstraction) is readable by any teammate via memberDetail.
// Editing/removing a trait is restricted to its owner — a person curates their
// own grain — so it needs that person's signed-in account (identities are unique
// per workspace). A token carries no identity, so it can't edit anyone's traits
// (no agent tool writes traits).
function accessTrait(req: Request, res: Response, trait: TraitRow | undefined): TraitRow | null {
  if (!trait) { res.status(404).json({ error: "not found" }); return null; }
  if (!authorizeProject(req, res, trait.project)) return null;
  if (env.authEnabled && (!req.userId || req.member !== trait.member)) {
    res.status(403).json({ error: "this trait belongs to another teammate" });
    return null;
  }
  return trait;
}

api.patch("/traits/:id", requireViewer, (req, res) => {
  const trait = accessTrait(req, res, getTrait(req.params.id!));
  if (!trait) return;
  const body = z
    .object({
      statement: z.string().trim().min(1).max(160).optional(),
      type: z.enum(TRAIT_TYPES as [TraitType, ...TraitType[]]).optional(),
    })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues });
  updateTrait(trait.id, body.data);
  bus.emitChange({ type: "profile.changed", project: trait.project, member: trait.member });
  res.json({ ok: true });
});

api.delete("/traits/:id", requireViewer, (req, res) => {
  const trait = accessTrait(req, res, getTrait(req.params.id!));
  if (!trait) return;
  dismissTrait(trait.id);
  bus.emitChange({ type: "profile.changed", project: trait.project, member: trait.member });
  res.json({ ok: true });
});

// ── LLM providers (per-workspace; admin-managed; keys encrypted at rest) ──
// A workspace's own providers override the instance default (operator REINS_LLM_*
// env, which is NOT editable here). All routes are admin-gated and scoped to the
// caller's workspace, so one workspace can't read or touch another's. API keys
// are NEVER returned — only a masked preview + whether a key is set.
function publicProvider(p: ReturnType<typeof listProviders>[number]) {
  const key = p.apiKey || "";
  const masked = key ? `${key.slice(0, 3)}…${key.slice(-4)}` : "";
  return {
    id: p.id,
    label: p.label,
    baseURL: p.baseURL,
    model: p.model,
    fastModel: p.fastModel,
    maxTokens: p.maxTokens,
    active: p.active,
    hasKey: Boolean(key),
    keyMask: masked,
  };
}

const wsOf = (req: Request) => req.workspaceId ?? "default";

const ProviderBody = z.object({
  label: z.string().min(1).max(80),
  baseURL: z.string().url(),
  model: z.string().min(1).max(120),
  fastModel: z.string().max(120).optional(),
  maxTokens: z.number().int().positive().max(200000).optional(),
  apiKey: z.string().max(400).optional(),
});

api.get("/providers", requireAdmin, (req, res) => {
  const ws = wsOf(req);
  res.json({
    providers: listProviders(ws).map(publicProvider),
    active: activeModel(ws),
    // Whether the operator's env fallback (REINS_LLM_*) has a key, so the UI can
    // tell "no providers, instance default in use" from "nothing configured".
    instanceDefault: envLlmConfigured,
  });
});

api.post("/providers", requireAdmin, (req, res) => {
  const parsed = ProviderBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message });
  const created = createProvider(wsOf(req), parsed.data);
  bus.emitChange({ type: "providers.changed" } as any);
  res.json({ provider: publicProvider({ ...created }) });
});

api.put("/providers/:id", requireAdmin, (req, res) => {
  const parsed = ProviderBody.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message });
  const updated = updateProvider(req.params.id!, wsOf(req), parsed.data);
  if (!updated) return res.status(404).json({ error: "no such provider" });
  bus.emitChange({ type: "providers.changed" } as any);
  res.json({ provider: publicProvider({ ...updated }) });
});

api.post("/providers/:id/activate", requireAdmin, (req, res) => {
  const ws = wsOf(req);
  if (!setActiveProvider(req.params.id!, ws)) return res.status(404).json({ error: "no such provider" });
  bus.emitChange({ type: "providers.changed" } as any);
  res.json({ ok: true, active: activeModel(ws) });
});

api.delete("/providers/:id", requireAdmin, (req, res) => {
  if (!deleteProvider(req.params.id!, wsOf(req))) return res.status(404).json({ error: "no such provider" });
  bus.emitChange({ type: "providers.changed" } as any);
  res.json({ ok: true });
});

// ── Lead actions (owners/admins) ──────────────────────────────
// Assign an area to one person, and post directives to members or the whole
// team. Reading them is open to every teammate (they're never hidden from the
// people they target); writing them needs owner/admin, like a team goal.

/** The lead's display name for directives/assignments: their capture identity,
 *  or "the lead" for a machine credential. */
const leadName = (req: Request) => req.member || "the lead";

function requireLead(req: Request, res: Response, project: string): boolean {
  if (!authorizeProject(req, res, project)) return false;
  if (!getProject(project)) { res.status(404).json({ error: "not found" }); return false; }
  if (!isWorkspaceAdmin(req)) { res.status(403).json({ error: "owner or admin role required" }); return false; }
  return true;
}

api.get("/projects/:id/lead", requireViewer, (req, res) => {
  if (!authorizeProject(req, res, req.params.id!)) return;
  res.json({
    directives: activeDirectives(req.params.id!).map((d) => ({
      id: d.id, text: d.text, targets: JSON.parse(d.targets || "[]"), by: d.created_by, createdAt: d.created_at, expiresAt: d.expires_at,
    })),
    assignments: activeAssignments(req.params.id!).map((a) => ({ id: a.id, member: a.member, area: a.area, note: a.note, by: a.created_by, createdAt: a.created_at })),
  });
});

const HOUR = 60 * 60 * 1000;
api.post("/projects/:id/directives", requireViewer, (req, res) => {
  const project = req.params.id!;
  if (!requireLead(req, res, project)) return;
  const body = z
    .object({
      text: z.string().trim().min(1).max(500),
      targets: z.array(z.string().trim().min(1).max(200)).max(50).default([]), // [] = whole team
      ttlHours: z.number().positive().max(24 * 30).default(24),
    })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues });
  const targets: string[] = [];
  for (const t of body.data.targets) {
    const id = resolveMember(project, t);
    if (!id) return res.status(400).json({ error: `no teammate "${t}" in this project` });
    if (!targets.includes(id)) targets.push(id);
  }
  const id = createDirective({ project, text: body.data.text, targets, createdBy: leadName(req), ttlMs: body.data.ttlHours * HOUR });
  bus.emitChange({ type: "lead.changed", project });
  res.json({ ok: true, id });
});

api.post("/directives/:id/clear", requireViewer, (req, res) => {
  const body = z.object({ project: z.string() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues });
  if (!requireLead(req, res, body.data.project)) return;
  if (!clearDirective(body.data.project, req.params.id!)) return res.status(404).json({ error: "not found" });
  bus.emitChange({ type: "lead.changed", project: body.data.project });
  res.json({ ok: true });
});

// Assign an area (a file/dir path or free text) to one teammate: a directed
// handoff to them plus an advisory claim the pre-edit check warns others about.
api.post("/projects/:id/assignments", requireViewer, (req, res) => {
  const project = req.params.id!;
  if (!requireLead(req, res, project)) return;
  const body = z
    .object({ area: z.string().trim().min(1).max(200), member: z.string().trim().min(1).max(200), note: z.string().trim().max(300).optional() })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues });
  const member = resolveMember(project, body.data.member);
  if (!member) return res.status(400).json({ error: `no teammate "${body.data.member}" in this project` });
  const { area, note } = body.data;
  const by = leadName(req);
  const text = `${area} is assigned to you by the lead${by !== "the lead" ? ` (${by})` : ""}${note ? ` — ${note}` : ""}.`;
  const handoffId = createHandoff({
    project, toMember: member, fromMember: req.member && listMembers(project).some((m) => m.member === req.member) ? req.member : undefined,
    kind: "assignment", text, area, conventions: handoffConventions(project, member, `${area} ${note ?? ""}`),
  });
  const id = createAssignment({ project, member, area, note: note ?? null, createdBy: by, handoffId });
  bus.emitChange({ type: "lead.changed", project });
  bus.emitChange({ type: "handoff.changed", project });
  res.json({ ok: true, id });
});

api.post("/assignments/:id/clear", requireViewer, (req, res) => {
  const body = z.object({ project: z.string() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues });
  if (!requireLead(req, res, body.data.project)) return;
  const a = activeAssignments(body.data.project).find((x) => x.id === req.params.id);
  if (!a || !clearAssignment(body.data.project, a.id)) return res.status(404).json({ error: "not found" });
  if (a.handoff_id) setHandoffStatus(body.data.project, a.handoff_id, "resolved");
  bus.emitChange({ type: "lead.changed", project: body.data.project });
  bus.emitChange({ type: "handoff.changed", project: body.data.project });
  res.json({ ok: true });
});

// ── Workspace settings (admin) ────────────────────────────────
api.get("/workspace/settings", requireViewer, (req, res) => {
  res.json({ hideBranches: workspaceHidesBranches(wsOf(req)) });
});

api.put("/workspace/settings", requireAdmin, (req, res) => {
  const body = z.object({ hideBranches: z.boolean() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues });
  setWorkspaceHidesBranches(wsOf(req), body.data.hideBranches);
  res.json({ ok: true, hideBranches: body.data.hideBranches });
});
