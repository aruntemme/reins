/**
 * Workspace screens (Today, My day, This week, an item, a person) and their
 * writes. Signed-in users only; every project / item / step / post / session is
 * checked against the caller's workspace (404 across tenants, like the rest).
 */
import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { getProject, ensureMember, addGoalItem, deleteGoal } from "../db.js";
import { bus } from "../bus.js";
import { requireUser, authorizeProject } from "../middleware.js";
import { roleIsAdmin } from "../auth.js";
import { getSessionById, attachSession } from "../sessions.js";
import {
  ITEM_KINDS, ITEM_STATUSES, POST_KINDS, getItem, getRelease, getStep, getPost, createItem, updateItem, tickStep, resolveTeammate,
  createRelease, updateRelease, submitPost, answerQuestion, resolvePost, delegatePost, handoverItem, unknownTeammate,
  todayView, meView, weekView, itemView, personView,
} from "../work.js";
import type { ItemRow, PostRow } from "../work.js";

export const work = Router();

const changed = (project: string) => bus.emitChange({ type: "work.changed", project });
const viewer = (req: Request) => ({ member: req.member!, role: req.userRole });
const isAdmin = (req: Request) => roleIsAdmin(req.userRole);

/** The viewer's day boundaries: tz = Date#getTimezoneOffset() minutes; since = epoch ms. */
function viewOpts(req: Request) {
  const tz = Number(req.query.tz);
  const since = Number(req.query.since);
  return {
    tz: Number.isFinite(tz) && Math.abs(tz) <= 14 * 60 ? Math.round(tz) : new Date().getTimezoneOffset(),
    since: Number.isFinite(since) && since > 0 ? since : undefined,
  };
}

function project(req: Request, res: Response): string | null {
  const id = req.params.id!;
  if (!authorizeProject(req, res, id)) return null;
  if (!getProject(id)) { res.status(404).json({ error: "not found" }); return null; }
  return id;
}

/** An item in the caller's workspace; with `edit`, only its owner or an owner/admin. */
function item(req: Request, res: Response, id: string, edit: boolean): ItemRow | null {
  const it = getItem(id);
  if (!it) { res.status(404).json({ error: "not found" }); return null; }
  if (!authorizeProject(req, res, it.project)) return null;
  if (edit && it.member !== req.member && !isAdmin(req)) {
    res.status(403).json({ error: "only the item's owner or a lead can change it" });
    return null;
  }
  return it;
}

function post(req: Request, res: Response): PostRow | null {
  const p = getPost(req.params.id!);
  if (!p) { res.status(404).json({ error: "not found" }); return null; }
  if (!authorizeProject(req, res, p.project)) return null;
  return p;
}

/** Can the viewer settle this ask: it is addressed to them, or they lead. */
const mayAnswer = (req: Request, p: PostRow) => p.to_member === req.member || isAdmin(req);

// ── Reads ─────────────────────────────────────────────────────
work.get("/projects/:id/today", requireUser, (req, res) => {
  const p = project(req, res);
  if (p) res.json(todayView(p, viewer(req), viewOpts(req)));
});

work.get("/projects/:id/me", requireUser, (req, res) => {
  const p = project(req, res);
  if (p) res.json(meView(p, viewer(req), viewOpts(req)));
});

work.get("/projects/:id/week", requireUser, (req, res) => {
  const p = project(req, res);
  if (!p) return;
  const days = Number(req.query.days ?? 7);
  res.json(weekView(p, Number.isInteger(days) && days >= 1 && days <= 31 ? days : 7, viewOpts(req)));
});

work.get("/projects/:id/items/:itemId", requireUser, (req, res) => {
  const p = project(req, res);
  if (!p) return;
  const view = itemView(p, req.params.itemId!, viewer(req));
  if (!view) return res.status(404).json({ error: "not found" });
  res.json(view);
});

work.get("/projects/:id/people/:member", requireUser, (req, res) => {
  const p = project(req, res);
  if (!p) return;
  const view = personView(p, req.params.member!, viewer(req), viewOpts(req));
  if (!view) return res.status(404).json({ error: "not found" });
  res.json(view);
});

// ── Items + steps ─────────────────────────────────────────────
const Title = z.string().trim().min(1).max(200);
const StepText = z.string().trim().min(1).max(300);
const Branch = z.string().trim().max(200).nullable();

work.post("/projects/:id/items", requireUser, (req, res) => {
  const p = project(req, res);
  if (!p) return;
  const body = z
    .object({
      title: Title, kind: z.enum(ITEM_KINDS), owner: z.string().trim().min(1).max(200).optional(),
      releaseId: z.string().nullable().optional(), steps: z.array(StepText).max(50).optional(), branch: Branch.optional(),
    })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues });
  const me = req.member!;
  let owner = me;
  if (body.data.owner && body.data.owner !== me) {
    const id = resolveTeammate(p, body.data.owner);
    if (!id) return res.status(400).json({ error: unknownTeammate(p, body.data.owner) });
    owner = id;
  }
  if (body.data.releaseId) {
    const r = getRelease(body.data.releaseId);
    if (!r || r.project !== p) return res.status(400).json({ error: "releaseId must be a release in this project" });
  }
  ensureMember(p, owner);
  const id = createItem({ project: p, owner, title: body.data.title, kind: body.data.kind, releaseId: body.data.releaseId, steps: body.data.steps, branch: body.data.branch, createdBy: me });
  changed(p);
  res.json({ ok: true, id, item: itemView(p, id, viewer(req))!.item });
});

work.patch("/items/:itemId", requireUser, (req, res) => {
  const it = item(req, res, req.params.itemId!, true);
  if (!it) return;
  const body = z
    .object({
      title: Title.optional(), kind: z.enum(ITEM_KINDS).optional(), owner: z.string().trim().min(1).max(200).optional(),
      status: z.enum(ITEM_STATUSES).optional(), releaseId: z.string().nullable().optional(), branch: Branch.optional(),
      note: z.string().trim().max(2000).optional(), // goes on the handover post when `owner` changes
    })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues });
  const { owner, note, ...rest } = body.data;
  if (rest.releaseId) {
    const r = getRelease(rest.releaseId);
    if (!r || r.project !== it.project) return res.status(400).json({ error: "releaseId must be a release in this project" });
  }
  let to: string | null = null;
  if (owner) {
    to = resolveTeammate(it.project, owner);
    if (!to) return res.status(400).json({ error: unknownTeammate(it.project, owner) });
  }
  updateItem(it, rest);
  if (to && to !== it.member) {
    ensureMember(it.project, req.member!);
    handoverItem(getItem(it.id)!, to, { author: req.member!, source: "web" }, note || undefined);
  }
  changed(it.project);
  res.json({ ok: true, item: itemView(it.project, it.id, viewer(req))!.item });
});

work.post("/items/:itemId/steps", requireUser, (req, res) => {
  const it = item(req, res, req.params.itemId!, true);
  if (!it) return;
  const body = z.object({ text: StepText }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues });
  const id = addGoalItem({ goalId: it.id, text: body.data.text });
  changed(it.project);
  res.json({ ok: true, id, step: { id, text: body.data.text, done: false } });
});

work.patch("/steps/:stepId", requireUser, (req, res) => {
  const step = getStep(req.params.stepId!);
  if (!step) return res.status(404).json({ error: "not found" });
  const it = item(req, res, step.goal_id, true);
  if (!it) return;
  const body = z.object({ done: z.boolean() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues });
  tickStep(step.id, body.data.done, { member: req.member!, source: "web" });
  changed(it.project);
  res.json({ ok: true });
});

// ── Releases (owners/admins) ──────────────────────────────────
const DueAt = z.number().int().positive().nullable();
function release(req: Request, res: Response): ItemRow | null {
  const r = getRelease(req.params.id!);
  if (!r) { res.status(404).json({ error: "not found" }); return null; }
  if (!authorizeProject(req, res, r.project)) return null;
  if (!isAdmin(req)) { res.status(403).json({ error: "owner or admin role required" }); return null; }
  return r;
}

work.post("/projects/:id/releases", requireUser, (req, res) => {
  const p = project(req, res);
  if (!p) return;
  if (!isAdmin(req)) return res.status(403).json({ error: "owner or admin role required" });
  const body = z.object({ title: Title, dueAt: DueAt.optional() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues });
  const id = createRelease({ project: p, title: body.data.title, dueAt: body.data.dueAt ?? null, createdBy: req.member });
  changed(p);
  res.json({ ok: true, id, release: { id, title: body.data.title, dueAt: body.data.dueAt ?? null } });
});

work.patch("/releases/:id", requireUser, (req, res) => {
  const r = release(req, res);
  if (!r) return;
  const body = z.object({ title: Title.optional(), dueAt: DueAt.optional(), status: z.enum(["open", "done"]).optional() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues });
  updateRelease(r, body.data);
  changed(r.project);
  res.json({ ok: true });
});

work.delete("/releases/:id", requireUser, (req, res) => {
  const r = release(req, res);
  if (!r) return;
  deleteGoal(r.id); // its items stay, just no longer in a release
  changed(r.project);
  res.json({ ok: true });
});

// ── Posts ─────────────────────────────────────────────────────
const PostText = z.string().trim().min(1).max(2000);

work.post("/projects/:id/posts", requireUser, (req, res) => {
  const p = project(req, res);
  if (!p) return;
  const body = z
    .object({ itemId: z.string().nullable().optional(), kind: z.enum(POST_KINDS), text: PostText, toMember: z.string().trim().max(200).nullable().optional(), replyTo: z.string().nullable().optional() })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues });
  ensureMember(p, req.member!);
  const r = submitPost(p, body.data, { author: req.member!, source: "web" });
  if ("error" in r) return res.status(r.status).json({ error: r.error });
  changed(p);
  res.json({ ok: true, id: r.post.id });
});

work.post("/posts/:id/answer", requireUser, (req, res) => {
  const q = post(req, res);
  if (!q) return;
  const body = z.object({ text: PostText }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues });
  if (q.kind !== "question" && q.kind !== "decision") return res.status(400).json({ error: "only a question or decision can be answered" });
  if (q.status !== "open") return res.status(409).json({ error: "already settled" });
  if (!mayAnswer(req, q)) return res.status(403).json({ error: "this was asked of someone else" });
  ensureMember(q.project, req.member!);
  const a = answerQuestion(q, { author: req.member!, source: "web", text: body.data.text });
  changed(q.project);
  res.json({ ok: true, id: a.id });
});

work.post("/posts/:id/resolve", requireUser, (req, res) => {
  const q = post(req, res);
  if (!q) return;
  const body = z.object({ status: z.enum(["approved", "changed", "dismissed"]), text: PostText.optional() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues });
  if (q.kind !== "question" && q.kind !== "decision") return res.status(400).json({ error: "only a question or decision can be resolved" });
  if (q.status !== "open") return res.status(409).json({ error: "already settled" });
  if (!mayAnswer(req, q) && q.author !== req.member) return res.status(403).json({ error: "this was asked of someone else" });
  ensureMember(q.project, req.member!);
  resolvePost(q, body.data.status, { author: req.member!, source: "web" }, body.data.text);
  changed(q.project);
  res.json({ ok: true });
});

work.post("/posts/:id/delegate", requireUser, (req, res) => {
  const q = post(req, res);
  if (!q) return;
  if (q.kind !== "question" && q.kind !== "decision") return res.status(400).json({ error: "only a question or decision can be delegated" });
  if (q.status !== "open") return res.status(409).json({ error: "already settled" });
  if (!(q.to_member === req.member || (!q.to_member && isAdmin(req)))) return res.status(403).json({ error: "only the person asked can let their agent answer" });
  delegatePost(q, req.member!);
  changed(q.project);
  res.json({ ok: true });
});

// ── Track untracked agent work as an item ─────────────────────
work.post("/sessions/:id/track", requireUser, (req, res) => {
  const s = getSessionById(req.params.id!);
  if (!s) return res.status(404).json({ error: "not found" });
  if (!authorizeProject(req, res, s.project)) return;
  if (s.member !== req.member && !isAdmin(req)) return res.status(403).json({ error: "only that agent's owner or a lead can track its work" });
  const body = z.object({ title: Title.optional(), kind: z.enum(ITEM_KINDS) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues });
  if (s.item_id) return res.status(409).json({ error: "that session is already on an item" });
  const workBranch = s.branch && !["main", "master", "HEAD"].includes(s.branch) ? s.branch : null;
  const title = body.data.title || s.last_line?.slice(0, 120) || (workBranch ? `Work on ${workBranch}` : "Untracked work");
  const id = createItem({ project: s.project, owner: s.member, title, kind: body.data.kind, branch: workBranch, createdBy: req.member });
  attachSession(s, id);
  changed(s.project);
  res.json({ ok: true, id, item: itemView(s.project, id, viewer(req))!.item });
});
