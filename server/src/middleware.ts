import type { Request, Response, NextFunction } from "express";
import { env } from "./env.js";
import { bearer, verifyToken, verifySession } from "./auth.js";
import { projectWorkspace } from "./db.js";

export const COOKIE = "reins_sess";

// req.workspaceId is set by the gates below.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      workspaceId?: string;
    }
  }
}

export function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

/** Hooks/agents posting events. Requires an ingest- or admin-kind token when auth is on. */
export function requireIngest(req: Request, res: Response, next: NextFunction) {
  if (!env.authEnabled) {
    req.workspaceId = "default";
    return next();
  }
  const info = verifyToken(bearer(req));
  if (!info || (info.kind !== "ingest" && info.kind !== "admin")) {
    return res.status(401).json({ error: "invalid or missing ingest token" });
  }
  req.workspaceId = info.workspaceId;
  next();
}

/** Dashboard reads/actions. Requires a session cookie or an access/admin token. */
export function requireViewer(req: Request, res: Response, next: NextFunction) {
  if (!env.authEnabled) {
    req.workspaceId = "default";
    return next();
  }
  const sess = verifySession(readCookie(req, COOKIE));
  if (sess) {
    req.workspaceId = sess.workspaceId;
    return next();
  }
  const info = verifyToken(bearer(req));
  if (info && (info.kind === "access" || info.kind === "admin")) {
    req.workspaceId = info.workspaceId;
    return next();
  }
  return res.status(401).json({ error: "authentication required" });
}

/** Admin-only operations (mint/revoke tokens). Accepts an admin session or admin token. */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!env.authEnabled) {
    req.workspaceId = "default";
    return next();
  }
  const sess = verifySession(readCookie(req, COOKIE));
  if (sess && sess.kind === "admin") {
    req.workspaceId = sess.workspaceId;
    return next();
  }
  const info = verifyToken(bearer(req));
  if (info && info.kind === "admin") {
    req.workspaceId = info.workspaceId;
    return next();
  }
  return res.status(401).json({ error: "admin token required" });
}

/** Guard: the project must belong to the caller's workspace. Returns false + responds on failure. */
export function authorizeProject(req: Request, res: Response, projectId: string): boolean {
  if (!env.authEnabled) return true;
  const ws = projectWorkspace(projectId);
  if (ws && ws === req.workspaceId) return true;
  // Don't leak existence across tenants — 404 either way.
  res.status(404).json({ error: "not found" });
  return false;
}
