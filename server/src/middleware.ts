import type { Request, Response, NextFunction } from "express";
import { env } from "./env.js";
import { bearer, verifyToken, verifySession, roleIsAdmin } from "./auth.js";
import { projectWorkspace } from "./db.js";
import type { Role } from "./auth.js";

export const COOKIE = "reins_sess";

// req.workspaceId (+ user identity for user sessions) is set by the gates below.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      workspaceId?: string;
      userId?: string;
      userRole?: Role;
      member?: string; // the user session's capture identity (effective member)
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
    req.userId = sess.userId;
    req.userRole = sess.role;
    req.member = sess.member;
    return next();
  }
  const info = verifyToken(bearer(req));
  if (info && (info.kind === "access" || info.kind === "admin")) {
    req.workspaceId = info.workspaceId;
    return next();
  }
  return res.status(401).json({ error: "authentication required" });
}

/**
 * Admin-only operations (mint/revoke tokens, manage members). Accepts an admin
 * token session, an admin token, OR a logged-in user whose membership role is
 * owner/admin — so a human owner can administer the workspace from the dashboard
 * without holding the raw admin token.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!env.authEnabled) {
    req.workspaceId = "default";
    return next();
  }
  const sess = verifySession(readCookie(req, COOKIE));
  if (sess && (sess.kind === "admin" || (sess.kind === "user" && roleIsAdmin(sess.role)))) {
    req.workspaceId = sess.workspaceId;
    req.userId = sess.userId;
    req.userRole = sess.role;
    req.member = sess.member;
    return next();
  }
  // A logged-in human who lacks owner/admin is authenticated but not authorized:
  // 403 (forbidden), distinct from the 401 we return when no credential is present.
  if (sess && sess.kind === "user") {
    return res.status(403).json({ error: "owner or admin role required" });
  }
  const info = verifyToken(bearer(req));
  if (info && info.kind === "admin") {
    req.workspaceId = info.workspaceId;
    return next();
  }
  return res.status(401).json({ error: "admin token required" });
}

/**
 * Gate for actions that require a logged-in human account (not a machine token):
 * switching the active workspace, joining via an invite. The session must carry a
 * userId. Sets req.workspaceId + req.userId for the handler.
 */
export function requireUser(req: Request, res: Response, next: NextFunction) {
  // A human account is required regardless of whether multi-tenant auth is on;
  // there is no "user" concept without a real signed-in session.
  const sess = verifySession(readCookie(req, COOKIE));
  if (sess && sess.kind === "user" && sess.userId) {
    req.workspaceId = sess.workspaceId;
    req.userId = sess.userId;
    req.userRole = sess.role;
    req.member = sess.member;
    return next();
  }
  return res.status(401).json({ error: "login required" });
}

/**
 * Does the current request carry owner/admin authority in its workspace? Used by
 * handlers (not as a gate) to allow elevated actions on an otherwise viewer-level
 * route — e.g. creating a TEAM goal. Mirrors requireAdmin's acceptance set.
 */
export function isWorkspaceAdmin(req: Request): boolean {
  if (!env.authEnabled) return true;
  const sess = verifySession(readCookie(req, COOKIE));
  if (sess && (sess.kind === "admin" || (sess.kind === "user" && roleIsAdmin(sess.role)))) return true;
  const info = verifyToken(bearer(req));
  return !!(info && info.kind === "admin");
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
