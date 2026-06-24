import { Router } from "express";
import { z } from "zod";
import { ingest } from "../pipeline/index.js";
import { runRollup } from "../pipeline/rollup.js";
import { projectSnapshot, projectsList, memberDetail } from "../state.js";
import { setGoal, setPendingStatus, getProject, setHandoffStatus } from "../db.js";
import { bus } from "../bus.js";
import { llmConfigured } from "../llm/client.js";
import { ogStats, ogRefreshBalance } from "../llm/og-compute.js";
import { storageStats } from "../llm/og-storage.js";
import { env, usesOG, usesRouter } from "../env.js";
import { requireIngest, requireViewer, authorizeProject } from "../middleware.js";

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
  res.json({ projects: projectsList(ws), llm: llmConfigured, auth: env.authEnabled });
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

api.post("/projects/:id/rollup", requireViewer, async (req, res) => {
  if (!authorizeProject(req, res, req.params.id!)) return;
  if (!getProject(req.params.id!)) return res.status(404).json({ error: "not found" });
  await runRollup(req.params.id!);
  res.json({ ok: true, rollup: projectSnapshot(req.params.id!)?.rollup ?? null });
});

// ── 0G status (powering the dashboard's "running on 0G" surface) ──
api.get("/og/status", requireViewer, async (_req, res) => {
  const computeOn = usesOG || usesRouter;
  if (!computeOn && !env.og.storageEnabled) return res.json({ enabled: false });
  if (usesOG) await ogRefreshBalance();
  res.json({
    enabled: true,
    network: "0G Galileo Testnet",
    chainId: 16602,
    explorer: env.og.explorer,
    compute: computeOn
      ? {
          mode: ogStats.mode, // "router" (pc.0g.ai) | "broker" (SDK)
          private: ogStats.private,
          ready: ogStats.ready,
          provider: ogStats.provider || undefined,
          model: ogStats.model,
          endpoint: ogStats.endpoint,
          requests: ogStats.requests,
          verified: ogStats.verified,
          unverifiable: ogStats.unverifiable,
          balance: ogStats.balance,
          lastError: ogStats.lastError || undefined,
        }
      : null,
    storage: env.og.storageEnabled
      ? {
          uploads: storageStats.uploads,
          lastRootHash: storageStats.lastRootHash || undefined,
          explorer: env.og.storageExplorer,
          lastError: storageStats.lastError || undefined,
        }
      : null,
  });
});
