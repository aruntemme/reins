/**
 * Agent API: what an agent's Reins tools call (cli/reins-mcp.mjs). Auth is the
 * hook's ingest token (requireHook), scoped to the token's workspace: a project
 * owned by another workspace is refused (403 writes, 404 reads), and every item,
 * step, post and session is checked to belong to the request's project.
 *
 * Bodies (and GET query strings) carry project, member, and the capture fields
 * (session, source, branch, worktree, repo_root). Without a session id, the
 * member's most recently seen session in that worktree (and agent) is used.
 */
import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { env } from "../env.js";
import { bus } from "../bus.js";
import { requireHook, counterMap, overLimit } from "../middleware.js";
import { ensureProject, ensureMember, projectWorkspace, getProject, addGoalItem } from "../db.js";
import { accepting } from "../pipeline/index.js";
import { captureFrom, resolveAgentSession, setSessionState, attachSession } from "../sessions.js";
import type { SessionRow } from "../sessions.js";
import {
  ITEM_KINDS, ITEM_STATUSES, POST_KINDS, getItem, getStep, createItem, updateItem, tickStep, resolveTeammate, unknownTeammate, submitPost, handoverItem,
  agentContext, itemSteps, itemKind, itemStatus,
} from "../work.js";
import type { ItemRow } from "../work.js";

export const agent = Router();

const hits = counterMap();
const MAX_PER_MIN = 600;
const changed = (project: string) => bus.emitChange({ type: "work.changed", project });

const Base = z.object({ project: z.string().trim().min(1).max(120), member: z.string().trim().min(1).max(200) });

interface Scope { project: string; member: string; session: SessionRow | null; source: string }

/** Resolve project + member + session for an agent call, enforcing the token's workspace. */
function scope(req: Request, res: Response, write: boolean): Scope | null {
  if (write && !accepting()) { res.status(503).json({ error: "server is shutting down" }); return null; }
  const input = write ? req.body : req.query;
  const base = Base.safeParse(input);
  if (!base.success) { res.status(400).json({ error: base.error.issues }); return null; }
  const { project, member } = base.data;
  const ws = req.workspaceId ?? "default";
  const owner = projectWorkspace(project);
  if (env.authEnabled && owner && owner !== ws) {
    res.status(write ? 403 : 404).json({ error: write ? `project "${project}" belongs to another workspace` : "not found" });
    return null;
  }
  if (overLimit(hits, ws, MAX_PER_MIN, 60_000)) { res.status(429).json({ error: "agent rate limit reached" }); return null; }
  if (!owner) {
    if (!write) { res.status(404).json({ error: "not found" }); return null; }
    ensureProject(project, undefined, ws);
  }
  if (write) ensureMember(project, member);
  const cap = captureFrom(input);
  const r = resolveAgentSession(project, member, { session: cap.session, source: cap.source, worktree: cap.worktree });
  if (r.error) { res.status(403).json({ error: r.error }); return null; }
  return { project, member, session: r.session, source: cap.source || r.session?.source || "agent" };
}

function itemIn(res: Response, s: Scope, id: string): ItemRow | null {
  const it = getItem(id);
  if (!it || it.project !== s.project) { res.status(404).json({ error: "no such item in this project" }); return null; }
  return it;
}

const itemOut = (it: ItemRow) => ({
  id: it.id, title: it.title, kind: itemKind(it), status: itemStatus(it),
  steps: itemSteps(it.id).map((st) => ({ id: st.id, text: st.text, done: !!st.done })),
});

agent.get("/agent/context", requireHook, (req, res) => {
  const s = scope(req, res, false);
  if (!s) return;
  if (!getProject(s.project)) return res.status(404).json({ error: "not found" });
  res.json(agentContext(s.project, s.member, s.session));
});

agent.post("/agent/items", requireHook, (req, res) => {
  const s = scope(req, res, true);
  if (!s) return;
  const body = z
    .object({
      title: z.string().trim().min(1).max(200), kind: z.enum(ITEM_KINDS),
      steps: z.array(z.string().trim().min(1).max(300)).max(50).optional(), branch: z.string().trim().max(200).optional(),
    })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues });
  const id = createItem({ project: s.project, owner: s.member, title: body.data.title, kind: body.data.kind, steps: body.data.steps, branch: body.data.branch, createdBy: s.member });
  if (s.session) attachSession(s.session, id);
  changed(s.project);
  res.json({ ok: true, id, item: itemOut(getItem(id)!) });
});

agent.post("/agent/steps/:id/done", requireHook, (req, res) => {
  const s = scope(req, res, true);
  if (!s) return;
  const step = getStep(req.params.id!);
  if (!step || step.project !== s.project) return res.status(404).json({ error: "no such step in this project" });
  tickStep(step.id, true, { member: s.member, source: s.source });
  changed(s.project);
  res.json({ ok: true, step: { id: step.id, done: true } });
});

agent.post("/agent/steps", requireHook, (req, res) => {
  const s = scope(req, res, true);
  if (!s) return;
  const body = z.object({ itemId: z.string().min(1), text: z.string().trim().min(1).max(300) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues });
  const it = itemIn(res, s, body.data.itemId);
  if (!it) return;
  const id = addGoalItem({ goalId: it.id, text: body.data.text });
  changed(s.project);
  res.json({ ok: true, id, step: { id, text: body.data.text, done: false } });
});

agent.post("/agent/items/:id/status", requireHook, (req, res) => {
  const s = scope(req, res, true);
  if (!s) return;
  const body = z.object({ status: z.enum(ITEM_STATUSES), note: z.string().trim().min(1).max(2000).optional() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues });
  const it = itemIn(res, s, req.params.id!);
  if (!it) return;
  updateItem(it, { status: body.data.status });
  if (body.data.note) submitPost(s.project, { itemId: it.id, kind: "update", text: body.data.note }, { author: s.member, source: s.source, sessionId: s.session?.id });
  // The agent's own session follows what it reported.
  const next = ({ blocked: "blocked", waiting: "waiting", doing: "working" } as const)[body.data.status as "blocked" | "waiting" | "doing"];
  if (s.session && next) setSessionState(s.session, next);
  changed(s.project);
  res.json({ ok: true });
});

agent.post("/agent/posts", requireHook, (req, res) => {
  const s = scope(req, res, true);
  if (!s) return;
  const body = z
    .object({
      itemId: z.string().nullable().optional(), kind: z.enum(POST_KINDS), text: z.string().trim().min(1).max(2000),
      toMember: z.string().trim().max(200).nullable().optional(), replyTo: z.string().nullable().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues });
  // A post about "my work" defaults to the session's current item.
  const input = { ...body.data, itemId: body.data.itemId ?? (body.data.kind !== "answer" ? s.session?.item_id : null) ?? null };
  const r = submitPost(s.project, input, { author: s.member, source: s.source, sessionId: s.session?.id });
  if ("error" in r) return res.status(r.status).json({ error: r.error });
  if (s.session && (body.data.kind === "question" || body.data.kind === "decision")) setSessionState(s.session, "waiting");
  changed(s.project);
  res.json({ ok: true, id: r.post.id });
});

agent.post("/agent/items/:id/handover", requireHook, (req, res) => {
  const s = scope(req, res, true);
  if (!s) return;
  const body = z.object({ toMember: z.string().trim().min(1).max(200), note: z.string().trim().max(2000).optional() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues });
  const it = itemIn(res, s, req.params.id!);
  if (!it) return;
  const to = resolveTeammate(s.project, body.data.toMember);
  if (!to) return res.status(400).json({ error: unknownTeammate(s.project, body.data.toMember) });
  const p = handoverItem(it, to, { author: s.member, source: s.source, sessionId: s.session?.id }, body.data.note);
  changed(s.project);
  res.json({ ok: true, id: p.id });
});

agent.post("/agent/sessions/:id/attach", requireHook, (req, res) => {
  const base = scope(req, res, true);
  if (!base) return;
  const cap = captureFrom(req.body);
  const r = resolveAgentSession(base.project, base.member, { session: req.params.id!, source: cap.source, worktree: cap.worktree });
  if (r.error) return res.status(403).json({ error: r.error });
  if (!r.session) return res.status(404).json({ error: "no such session in this project" });
  const body = z.object({ itemId: z.string().min(1).nullable() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues });
  if (body.data.itemId && !itemIn(res, base, body.data.itemId)) return;
  attachSession(r.session, body.data.itemId);
  changed(base.project);
  res.json({ ok: true, sessionId: r.session.id, itemId: body.data.itemId });
});
