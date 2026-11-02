/**
 * Endpoints the capture hook calls from inside a coding agent's turn. They must
 * answer fast (the hook gives up after 300–800ms and stays silent), so nothing
 * here calls the LLM: a touch is one upsert plus the deterministic collision
 * check, and the pack/check reads are a handful of indexed queries.
 */
import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { ensureProject, ensureMember, touchMember, projectWorkspace, recordTouch } from "../db.js";
import { env } from "../env.js";
import { bus } from "../bus.js";
import { requireHook, counterMap, overLimit } from "../middleware.js";
import { applyGitMeta, editWarnings, reconcileCollisions } from "../collisions.js";
import { buildMemberPack } from "../context-pack.js";
import { redactSecrets } from "../redact.js";
import { accepting } from "../pipeline/index.js";

export const hook = Router();

const touchHits = counterMap();
const readHits = counterMap();
const TOUCH_MAX_PER_MIN = 600;
const READ_MAX_PER_MIN = 1200;

const Base = {
  project: z.string().trim().min(1).max(120),
  member: z.string().trim().min(1).max(200),
};
// Repo-relative path (the hook strips the git root); absolute paths are refused so
// one person's home directory layout never lands on the shared board.
const RelPath = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .transform((p) => p.replace(/\\/g, "/").replace(/^\.\//, ""))
  .refine((p) => !p.startsWith("/") && !/^[A-Za-z]:\//.test(p) && !p.split("/").includes(".."), "path must be relative to the repo root");

/** Resolve the project for a hook call. A project owned by another workspace is
 *  refused (403 for writes; reads answer empty so the hook stays silent). */
function hookProject(req: Request, res: Response, project: string, write: boolean): "ok" | "missing" | null {
  const ws = req.workspaceId ?? "default";
  const owner = projectWorkspace(project);
  if (env.authEnabled && owner && owner !== ws) {
    if (write) res.status(403).json({ error: `project "${project}" belongs to another workspace` });
    else res.json({ text: "", version: "", shown: [], warnings: [] });
    return null;
  }
  return owner ? "ok" : "missing";
}

// PostToolUse on an edit tool: record the touched path. Detached from the agent
// (the hook posts from a background child), and cheap: no LLM.
hook.post("/hook/touch", requireHook, (req, res) => {
  if (!accepting()) return res.status(503).json({ error: "server is shutting down" });
  const body = z
    .object({ ...Base, displayName: z.string().max(120).optional(), path: RelPath, tool: z.string().max(40).optional(), meta: z.unknown().optional() })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues });
  const { project, member, displayName, path, tool, meta } = body.data;
  if (!hookProject(req, res, project, true)) return;
  const ws = req.workspaceId ?? "default";
  if (overLimit(touchHits, ws, TOUCH_MAX_PER_MIN, 60_000)) return res.status(429).json({ error: "touch rate limit reached" });
  ensureProject(project, undefined, ws);
  ensureMember(project, member, displayName);
  touchMember(project, member);
  recordTouch(project, member, path, tool);
  bus.emitChange({ type: "touch", project, member });
  // Git state rides along (and runs the collision check); otherwise check here.
  if (!applyGitMeta(project, member, meta)) reconcileCollisions(project);
  res.json({ ok: true });
});

// PreToolUse on an edit tool: who else is on this file? Answered in a few ms; the
// hook turns any warning into non-blocking context for the model.
hook.post("/hook/check", requireHook, (req, res) => {
  const body = z.object({ ...Base, path: RelPath }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues });
  const { project, member, path } = body.data;
  const p = hookProject(req, res, project, false);
  if (!p) return;
  if (p === "missing") return res.json({ warnings: [], text: "" });
  if (overLimit(readHits, req.workspaceId ?? "default", READ_MAX_PER_MIN, 60_000)) return res.json({ warnings: [], text: "" });
  res.json(editWarnings(project, member, path));
});

// SessionStart (mode start) and UserPromptSubmit (mode delta): the member's
// compact team pack, or just what changed since the keys the session has seen.
// POST, not GET, because the prompt text rides along for relevance ranking and
// must not end up in URLs or access logs.
hook.post("/hook/pack", requireHook, (req, res) => {
  const body = z
    .object({
      ...Base,
      mode: z.enum(["start", "delta"]),
      query: z.string().max(4000).optional(),
      seen: z.array(z.string().max(80)).max(400).optional(),
    })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues });
  const { project, member, mode, query, seen } = body.data;
  const p = hookProject(req, res, project, false);
  if (!p) return;
  if (p === "missing") return res.json({ version: "", text: "", shown: [] });
  if (overLimit(readHits, req.workspaceId ?? "default", READ_MAX_PER_MIN, 60_000)) return res.json({ version: "", text: "", shown: [] });
  const q = query ? redactSecrets(query).slice(0, 500) : undefined;
  res.json(buildMemberPack(project, member, { mode, query: q, seen }));
});
