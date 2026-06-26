import { Router } from "express";
import type { Request } from "express";
import { z } from "zod";
import { env } from "../env.js";
import {
  verifyToken,
  verifySession,
  signSession,
  signUserSession,
  getWorkspace,
  mintToken,
  listTokens,
  revokeToken,
  createWorkspace,
  bearer,
  normalizeEmail,
  getUserByEmail,
  getUserById,
  createUser,
  verifyPassword,
  addMembership,
  getMembership,
  setMembershipMember,
  effectiveMember,
  listMemberships,
  touchUserLogin,
  acceptInvite,
  getInvite,
  useReset,
  roleIsAdmin,
  listMembers,
  createInvite,
  setMemberRole,
  removeMembership,
  countOwners,
} from "../auth.js";
import { COOKIE, requireAdmin, requireUser, readCookie } from "../middleware.js";

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

/** Set the session cookie using the same name + options as token login. */
function setSessionCookie(res: { setHeader(n: string, v: string): void }, value: string) {
  res.setHeader("Set-Cookie", `${COOKIE}=${value}; ${cookieOpts()}`);
}

// ── In-memory abuse guards ────────────────────────────────────
// Per-IP rate limit for signup (cheap defense against bulk account creation)
// and per-email failed-login backoff (defense against password guessing).
// In-memory is intentional: a single instance, and a restart only relaxes the
// guard, never tightens it. Distributed enforcement would need shared state.
const SIGNUP_WINDOW_MS = 60_000;
const SIGNUP_MAX = 5; // signups per IP per window
const signupHits = new Map<string, number[]>();

const LOGIN_FAIL_WINDOW_MS = 15 * 60_000;
const LOGIN_FAIL_MAX = 8; // failed attempts per email before temporary lockout
const loginFails = new Map<string, number[]>();

function clientIp(req: Request): string {
  // trust the socket address; behind a proxy the operator should set trust proxy,
  // but for the guard a stable-enough key is sufficient.
  return (req.ip || req.socket.remoteAddress || "unknown").toString();
}

function recentHits(map: Map<string, number[]>, key: string, windowMs: number): number[] {
  const cutoff = Date.now() - windowMs;
  const hits = (map.get(key) ?? []).filter((t) => t > cutoff);
  map.set(key, hits);
  return hits;
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
  // Human account session: surface the user, their role, and every workspace they
  // belong to so the dashboard can render a workspace switcher.
  if (sess && sess.kind === "user" && sess.userId) {
    const user = getUserById(sess.userId);
    return res.json({
      auth: true,
      user: user ? { email: user.email } : null,
      workspace: getWorkspace(sess.workspaceId) ?? null,
      workspaces: listMemberships(sess.userId),
      role: sess.role,
      admin: roleIsAdmin(sess.role),
      member: sess.member ?? null, // the capture identity this account acts as
    });
  }
  // Token-based session/bearer (machine credential).
  const info = sess ? { workspaceId: sess.workspaceId, kind: sess.kind } : verifyToken(bearer(req));
  if (!info) return res.json({ auth: true, workspace: null, admin: false });
  res.json({ auth: true, workspace: getWorkspace(info.workspaceId) ?? null, admin: info.kind === "admin" });
});

// ── Accounts (email + password) ───────────────────────────────
const PASSWORD = z.string().min(10, "password must be at least 10 characters");
const EMAIL = z.string().trim().email();

// Sign up: creates the user, their own workspace, an owner membership, and the
// default machine tokens. Logs them straight in by setting the session cookie.
auth.post("/auth/signup", (req, res) => {
  const ip = clientIp(req);
  const hits = recentHits(signupHits, ip, SIGNUP_WINDOW_MS);
  if (hits.length >= SIGNUP_MAX) {
    return res.status(429).json({ error: "too many signups, please wait a minute and try again" });
  }

  const body = z
    .object({ email: EMAIL, password: PASSWORD, workspaceName: z.string().trim().min(1).max(60).optional() })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues });

  const email = normalizeEmail(body.data.email);
  if (getUserByEmail(email)) {
    return res.status(409).json({ error: "an account with that email already exists" });
  }

  // Count the attempt only once we know the request is well-formed.
  signupHits.set(ip, [...hits, Date.now()]);

  const user = createUser(email, body.data.password);
  const localPart = email.split("@")[0] || "my";
  const ws = createWorkspace(body.data.workspaceName || `${localPart}'s workspace`);
  addMembership(user.id, ws.id, "owner");

  // Machine credentials for hooks/agents/MCP; shown once.
  const tokens = {
    ingest: mintToken(ws.id, "ingest", "default"),
    access: mintToken(ws.id, "access", "default"),
    admin: mintToken(ws.id, "admin", "default"),
  };

  touchUserLogin(user.id);
  setSessionCookie(res, signUserSession(user.id, ws.id, "owner"));
  res.json({ ok: true, user: { email: user.email }, workspace: getWorkspace(ws.id), tokens });
});

// Log in. Generic 401 on any failure so we never reveal whether an email exists.
auth.post("/auth/login", (req, res) => {
  const body = z.object({ email: EMAIL, password: z.string().min(1) }).safeParse(req.body);
  if (!body.success) return res.status(401).json({ error: "invalid email or password" });

  const email = normalizeEmail(body.data.email);
  const fails = recentHits(loginFails, email, LOGIN_FAIL_WINDOW_MS);
  if (fails.length >= LOGIN_FAIL_MAX) {
    // Backoff: stop checking passwords entirely while locked out.
    return res.status(429).json({ error: "too many attempts, please try again later" });
  }

  const row = getUserByEmail(email);
  if (!row || !verifyPassword(body.data.password, row.password_hash)) {
    loginFails.set(email, [...fails, Date.now()]);
    return res.status(401).json({ error: "invalid email or password" });
  }
  loginFails.delete(email); // successful login clears the backoff

  const memberships = listMemberships(row.id);
  const primary = memberships[0];
  if (!primary) {
    // A user with no workspace cannot have an active session; treat as misconfigured.
    return res.status(403).json({ error: "account has no workspace" });
  }
  touchUserLogin(row.id);
  setSessionCookie(res, signUserSession(row.id, primary.id, primary.role));
  res.json({
    ok: true,
    user: { email: row.email },
    workspace: getWorkspace(primary.id),
    workspaces: memberships,
  });
});

// Set the capture identity ("how your agent reports you") for the active
// workspace, so the server can tie your account to your goals/activity. Empty
// string clears it back to your email.
auth.post("/auth/member", requireUser, (req, res) => {
  const body = z.object({ member: z.string().trim().max(120) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues });
  setMembershipMember(req.userId!, req.workspaceId!, body.data.member || null);
  res.json({ ok: true, member: effectiveMember(req.userId!, req.workspaceId!) ?? null });
});

// Switch the active workspace for a logged-in account.
auth.post("/auth/switch", requireUser, (req, res) => {
  const body = z.object({ workspaceId: z.string().min(1) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "workspaceId required" });
  const m = getMembership(req.userId!, body.data.workspaceId);
  if (!m) return res.status(403).json({ error: "not a member of that workspace" });
  setSessionCookie(res, signUserSession(req.userId!, body.data.workspaceId, m.role));
  res.json({ ok: true, workspace: getWorkspace(body.data.workspaceId) });
});

// Join a workspace via an invite code (consumes the invite).
auth.post("/auth/join", requireUser, (req, res) => {
  const body = z.object({ code: z.string().min(1) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "code required" });
  const result = acceptInvite(body.data.code, req.userId!);
  if (!result) return res.status(400).json({ error: "invalid or expired invite" });
  res.json({ ok: true, workspace: getWorkspace(result.workspaceId), role: result.role });
});

// Public invite preview: just enough to render the join screen, nothing more.
auth.get("/invites/:code", (req, res) => {
  const invite = getInvite(req.params.code!);
  if (!invite) return res.status(404).json({ error: "invite not found" });
  const ws = getWorkspace(invite.workspaceId);
  res.json({ workspace: ws?.name ?? null, role: invite.role, valid: invite.valid });
});

// Complete a password reset with a single-use code.
auth.post("/auth/reset", (req, res) => {
  const body = z.object({ code: z.string().min(1), password: PASSWORD }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues });
  if (!useReset(body.data.code, body.data.password)) {
    return res.status(400).json({ error: "invalid or expired reset code" });
  }
  res.json({ ok: true });
});

// ── Workspace member + invite management (owner/admin only) ───
const ROLE = z.enum(["owner", "admin", "member"]);

/** requireAdmin sets req.workspaceId; the URL workspace must match it (no cross-tenant). */
function sameWorkspace(req: Request, res: { status(n: number): { json(b: unknown): unknown } }): boolean {
  if (req.params.id !== req.workspaceId) {
    // Don't leak whether the other workspace exists.
    res.status(404).json({ error: "not found" });
    return false;
  }
  return true;
}

auth.get("/workspaces/:id/members", requireAdmin, (req, res) => {
  if (!sameWorkspace(req, res)) return;
  res.json({ members: listMembers(req.params.id!) });
});

auth.post("/workspaces/:id/invites", requireAdmin, (req, res) => {
  if (!sameWorkspace(req, res)) return;
  const body = z.object({ role: ROLE, label: z.string().trim().max(60).optional() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues });
  const { code } = createInvite(req.params.id!, body.data.role, req.userId, body.data.label);
  // Build an absolute join URL from the caller's Origin when present; otherwise a
  // relative path the dashboard can resolve against its own host.
  const origin = req.get("origin");
  const url = origin ? `${origin}/join?code=${encodeURIComponent(code)}` : `/join?code=${encodeURIComponent(code)}`;
  res.json({ ok: true, code, url });
});

auth.post("/workspaces/:id/members/:userId/role", requireAdmin, (req, res) => {
  if (!sameWorkspace(req, res)) return;
  const body = z.object({ role: ROLE }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues });
  const target = getMembership(req.params.userId!, req.params.id!);
  if (!target) return res.status(404).json({ error: "member not found" });
  // Never leave a workspace without an owner.
  if (target.role === "owner" && body.data.role !== "owner" && countOwners(req.params.id!) <= 1) {
    return res.status(400).json({ error: "cannot demote the last owner" });
  }
  setMemberRole(req.params.userId!, req.params.id!, body.data.role);
  res.json({ ok: true });
});

auth.delete("/workspaces/:id/members/:userId", requireAdmin, (req, res) => {
  if (!sameWorkspace(req, res)) return;
  const target = getMembership(req.params.userId!, req.params.id!);
  if (!target) return res.status(404).json({ error: "member not found" });
  if (target.role === "owner" && countOwners(req.params.id!) <= 1) {
    return res.status(400).json({ error: "cannot remove the last owner" });
  }
  res.json({ ok: removeMembership(req.params.userId!, req.params.id!) });
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
