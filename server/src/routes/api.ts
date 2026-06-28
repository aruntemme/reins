import { Router } from "express";
import { z } from "zod";
import { ingest } from "../pipeline/index.js";
import { runRollup } from "../pipeline/rollup.js";
import { projectSnapshot, projectsList, memberDetail } from "../state.js";
import { setGoal, setPendingStatus, getProject, setHandoffStatus, resolveHandoffs, listPending, ensureProject, projectWorkspace } from "../db.js";
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
import { env } from "../env.js";
import type { Request, Response } from "express";
import { requireIngest, requireViewer, requireAdmin, authorizeProject, isWorkspaceAdmin } from "../middleware.js";

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

api.post("/ingest", requireIngest, async (req, res) => {
  // Back-compat single-key mode (only when full auth is off).
  if (!env.authEnabled && env.ingestKey && req.header("x-reins-key") !== env.ingestKey) {
    return res.status(401).json({ error: "bad key" });
  }
  const parsed = IngestBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
  const { eventId } = await ingest({ ...parsed.data, workspaceId: req.workspaceId });
  res.json({ ok: true, eventId });
});

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
  setPendingStatus(req.params.id!, "claimed", body.data.by);
  bus.emitChange({ type: "pending.changed", project: body.data.project });
  res.json({ ok: true });
});

api.post("/pending/:id/done", requireViewer, (req, res) => {
  const body = z.object({ project: z.string() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues });
  if (!authorizeProject(req, res, body.data.project)) return;
  setPendingStatus(req.params.id!, "done");
  bus.emitChange({ type: "pending.changed", project: body.data.project });
  res.json({ ok: true });
});

api.post("/handoffs/:id/:action", requireViewer, (req, res) => {
  const { action } = req.params;
  if (action !== "ack" && action !== "resolve") return res.status(400).json({ error: "bad action" });
  const body = z.object({ project: z.string() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues });
  if (!authorizeProject(req, res, body.data.project)) return;
  setHandoffStatus(req.params.id!, action === "ack" ? "ack" : "resolved");
  bus.emitChange({ type: "handoff.changed", project: body.data.project });
  res.json({ ok: true });
});

// Bulk-clear a member's incoming handoffs, optionally just one kind (respects an
// active filter in the UI). Same authority as a single resolve: any viewer of the
// project can clear what's directed at this member.
api.post("/projects/:id/handoffs/resolve", requireViewer, (req, res) => {
  if (!authorizeProject(req, res, req.params.id!)) return;
  const body = z
    .object({ member: z.string().min(1), kind: z.enum(["mention", "collision", "blocker", "fyi"]).optional() })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues });
  const resolved = resolveHandoffs(req.params.id!, body.data);
  if (resolved > 0) bus.emitChange({ type: "handoff.changed", project: req.params.id! });
  res.json({ ok: true, resolved });
});

api.post("/projects/:id/rollup", requireViewer, async (req, res) => {
  if (!authorizeProject(req, res, req.params.id!)) return;
  if (!getProject(req.params.id!)) return res.status(404).json({ error: "not found" });
  await runRollup(req.params.id!);
  res.json({ ok: true, rollup: projectSnapshot(req.params.id!)?.rollup ?? null });
});

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
// own grain. A token session (an agent acting as that member) is allowed through,
// mirroring goal access.
function accessTrait(req: Request, res: Response, trait: TraitRow | undefined): TraitRow | null {
  if (!trait) { res.status(404).json({ error: "not found" }); return null; }
  if (!authorizeProject(req, res, trait.project)) return null;
  if (req.userId && req.member !== trait.member) {
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

// ── LLM providers (instance-wide; admin-managed; keys encrypted at rest) ──
// API keys are NEVER returned to the client — only a masked preview + whether a
// key is set. Mutations are admin-gated (open instance = always admin).
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

const ProviderBody = z.object({
  label: z.string().min(1).max(80),
  baseURL: z.string().url(),
  model: z.string().min(1).max(120),
  fastModel: z.string().max(120).optional(),
  maxTokens: z.number().int().positive().max(200000).optional(),
  apiKey: z.string().max(400).optional(),
});

api.get("/providers", requireViewer, (_req, res) => {
  res.json({
    providers: listProviders().map(publicProvider),
    active: activeModel(),
  });
});

api.post("/providers", requireAdmin, (req, res) => {
  const parsed = ProviderBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message });
  const created = createProvider(parsed.data);
  bus.emitChange({ type: "providers.changed" } as any);
  res.json({ provider: publicProvider({ ...created }) });
});

api.put("/providers/:id", requireAdmin, (req, res) => {
  const parsed = ProviderBody.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message });
  const updated = updateProvider(req.params.id!, parsed.data);
  if (!updated) return res.status(404).json({ error: "no such provider" });
  bus.emitChange({ type: "providers.changed" } as any);
  res.json({ provider: publicProvider({ ...updated }) });
});

api.post("/providers/:id/activate", requireAdmin, (req, res) => {
  if (!setActiveProvider(req.params.id!)) return res.status(404).json({ error: "no such provider" });
  bus.emitChange({ type: "providers.changed" } as any);
  res.json({ ok: true, active: activeModel() });
});

api.delete("/providers/:id", requireAdmin, (req, res) => {
  if (!deleteProvider(req.params.id!)) return res.status(404).json({ error: "no such provider" });
  bus.emitChange({ type: "providers.changed" } as any);
  res.json({ ok: true });
});
