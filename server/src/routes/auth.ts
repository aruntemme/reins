import { Router } from "express";
import { z } from "zod";
import { env } from "../env.js";
import {
  verifyToken,
  verifySession,
  signSession,
  getWorkspace,
  mintToken,
  listTokens,
  revokeToken,
  createWorkspace,
  bearer,
} from "../auth.js";
import { COOKIE, requireAdmin, readCookie } from "../middleware.js";

export const auth = Router();

function cookieOpts() {
  // "auto" = secure only in production (so http://localhost dev still stores the cookie).
  const secure =
    env.cookieSecure === "on"
      ? true
      : env.cookieSecure === "off"
        ? false
        : process.env.NODE_ENV === "production";
  return `HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000${secure ? "; Secure" : ""}`;
}

// Exchange an access/admin token for a session cookie.
auth.post("/auth/session", (req, res) => {
  const body = z.object({ token: z.string().min(1) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "token required" });
  const info = verifyToken(body.data.token);
  if (!info || (info.kind !== "access" && info.kind !== "admin")) {
    return res.status(401).json({ error: "invalid token" });
  }
  res.setHeader("Set-Cookie", `${COOKIE}=${signSession(info.workspaceId, info.kind)}; ${cookieOpts()}`);
  res.json({ ok: true, workspace: getWorkspace(info.workspaceId), admin: info.kind === "admin" });
});

auth.post("/auth/logout", (_req, res) => {
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

// Who am I / is auth even on? Used by the web to decide whether to show sign-in.
auth.get("/auth/me", (req, res) => {
  if (!env.authEnabled) return res.json({ auth: false, workspace: { id: "default", name: "Local" }, admin: true });
  const sess = verifySession(readCookie(req, COOKIE));
  const info = sess ? { workspaceId: sess.workspaceId, kind: sess.kind } : verifyToken(bearer(req));
  if (!info) return res.json({ auth: true, workspace: null, admin: false });
  res.json({ auth: true, workspace: getWorkspace(info.workspaceId) ?? null, admin: info.kind === "admin" });
});

// ── Admin: manage tokens (admin-token gated) ──────────────────
auth.post("/admin/tokens", requireAdmin, (req, res) => {
  const body = z
    .object({ kind: z.enum(["ingest", "access", "admin"]), label: z.string().optional() })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues });
  const token = mintToken(req.workspaceId!, body.data.kind, body.data.label);
  res.json({ ok: true, token, note: "store this now — it is not shown again" });
});

auth.get("/admin/tokens", requireAdmin, (req, res) => {
  res.json({ tokens: listTokens(req.workspaceId!) });
});

// Invite a teammate: mint an ingest token (their agent) and, optionally, an
// access token (dashboard viewing). Both are workspace-scoped.
auth.post("/admin/invite", requireAdmin, (req, res) => {
  const body = z
    .object({ name: z.string().trim().min(1).max(60).optional(), access: z.boolean().optional() })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues });
  const label = body.data.name;
  const ingest = mintToken(req.workspaceId!, "ingest", label);
  const access = body.data.access ? mintToken(req.workspaceId!, "access", label) : undefined;
  res.json({ ok: true, name: label ?? null, ingest, access });
});

auth.post("/admin/tokens/:id/revoke", requireAdmin, (req, res) => {
  res.json({ ok: revokeToken(req.params.id!) });
});

// Admin can spin up an additional workspace (rare; usually via the CLI bootstrap).
auth.post("/admin/workspaces", requireAdmin, (req, res) => {
  const body = z.object({ name: z.string().min(1) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "name required" });
  const ws = createWorkspace(body.data.name);
  const adminToken = mintToken(ws.id, "admin", "bootstrap");
  res.json({ ok: true, workspace: ws, adminToken });
});
