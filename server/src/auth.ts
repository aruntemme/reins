import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { db, now } from "./db.js";
import { env } from "./env.js";

export type TokenKind = "ingest" | "access" | "admin";
export type Role = "owner" | "admin" | "member";

// Owner/admin can manage members and tokens; member can view and act on projects.
export function roleIsAdmin(role: Role | undefined): boolean {
  return role === "owner" || role === "admin";
}

// ── Session secret ────────────────────────────────────────────
// Stable secret required to sign dashboard sessions. If none is configured
// while auth is on, generate an ephemeral one (sessions won't survive restart).
let SECRET = env.sessionSecret;
if (env.authEnabled && !SECRET) {
  SECRET = randomBytes(32).toString("hex");
  console.warn(
    "[auth] REINS_SESSION_SECRET not set — using an ephemeral secret. Dashboard sessions will reset on restart."
  );
}

// ── Tokens ────────────────────────────────────────────────────
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function generateToken(kind: TokenKind): string {
  return `rk_${kind}_${randomBytes(24).toString("hex")}`;
}

export function createWorkspace(name: string): { id: string } {
  const id = randomUUID().slice(0, 8);
  db.prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)").run(id, name, now());
  return { id };
}

export function getWorkspace(id: string): { id: string; name: string } | undefined {
  return db.prepare("SELECT id, name FROM workspaces WHERE id = ?").get(id) as any;
}

export function listWorkspaces(): { id: string; name: string }[] {
  return db.prepare("SELECT id, name FROM workspaces ORDER BY created_at").all() as any;
}

/**
 * Workspaces with the counts that tell a live workspace apart from an empty
 * duplicate: projects, events (captured activity), agent members, and human
 * accounts. Used by `admin list-workspaces` so claiming the right one is
 * unambiguous.
 */
export function listWorkspacesDetailed(): {
  id: string;
  name: string;
  projects: number;
  events: number;
  members: number;
  accounts: number;
  created_at: number;
}[] {
  return db
    .prepare(
      `SELECT
         w.id   AS id,
         w.name AS name,
         w.created_at AS created_at,
         (SELECT COUNT(*) FROM projects p WHERE p.workspace_id = w.id) AS projects,
         (SELECT COUNT(*) FROM events e
            JOIN projects p ON p.id = e.project WHERE p.workspace_id = w.id) AS events,
         (SELECT COUNT(*) FROM members m
            JOIN projects p ON p.id = m.project WHERE p.workspace_id = w.id) AS members,
         (SELECT COUNT(*) FROM memberships ms WHERE ms.workspace_id = w.id) AS accounts
       FROM workspaces w
       ORDER BY w.created_at`
    )
    .all() as any;
}

/** Mint a token; returns the plaintext ONCE (only its hash is stored). */
export function mintToken(workspaceId: string, kind: TokenKind, label?: string): string {
  const token = generateToken(kind);
  db.prepare(
    `INSERT INTO tokens (id, workspace_id, kind, hash, prefix, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(randomUUID(), workspaceId, kind, sha256(token), token.slice(0, 14), label ?? null, now());
  return token;
}

export interface TokenInfo {
  workspaceId: string;
  kind: TokenKind;
}

export function verifyToken(token: string | undefined): TokenInfo | null {
  if (!token) return null;
  const row = db
    .prepare("SELECT id, workspace_id, kind FROM tokens WHERE hash = ? AND revoked = 0")
    .get(sha256(token)) as any;
  if (!row) return null;
  db.prepare("UPDATE tokens SET last_used = ? WHERE id = ?").run(now(), row.id);
  return { workspaceId: row.workspace_id, kind: row.kind };
}

export function listTokens(workspaceId: string): any[] {
  return db
    .prepare("SELECT id, kind, prefix, label, created_at, last_used, revoked FROM tokens WHERE workspace_id = ? ORDER BY created_at")
    .all(workspaceId);
}

export function revokeToken(id: string): boolean {
  const r = db.prepare("UPDATE tokens SET revoked = 1 WHERE id = ?").run(id);
  return r.changes > 0;
}

// ── Sessions (stateless, HMAC-signed cookie) ──────────────────
const b64 = (s: string) => Buffer.from(s).toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url").toString();

export function signSession(workspaceId: string, kind: TokenKind = "access"): string {
  const payload = b64(JSON.stringify({ ws: workspaceId, k: kind, iat: now() }));
  const sig = createHmac("sha256", SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

/** Sign a session for a logged-in user with an active workspace. */
export function signUserSession(userId: string, workspaceId: string, role: Role): string {
  const payload = b64(JSON.stringify({ uid: userId, ws: workspaceId, k: "user", role, iat: now() }));
  const sig = createHmac("sha256", SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export interface SessionInfo {
  workspaceId: string;
  kind: TokenKind | "user";
  userId?: string;
  role?: Role;
  member?: string; // the account's capture identity in this workspace (user sessions only)
}

export function verifySession(cookie: string | undefined): SessionInfo | null {
  if (!cookie || !cookie.includes(".")) return null;
  const [payload, sig] = cookie.split(".");
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", SECRET).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(unb64(payload));
    if (!data.ws || !getWorkspace(data.ws)) return null;
    // User session: membership is authoritative, so a removed/role-changed member
    // loses access (or gets the new role) without needing to re-login.
    if (data.uid) {
      const m = getMembership(data.uid, data.ws);
      if (!m) return null;
      const member = m.member ?? getUserById(data.uid)?.email;
      return { workspaceId: data.ws, kind: "user", userId: data.uid, role: m.role, member };
    }
    return { workspaceId: data.ws, kind: (data.k as TokenKind) ?? "access" };
  } catch {
    return null;
  }
}

/** Extract a bearer token from common header shapes. */
export function bearer(req: { header(name: string): string | undefined }): string | undefined {
  const auth = req.header("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  return req.header("x-reins-key") || undefined;
}

// ── Passwords (scrypt, dependency-free) ───────────────────────
export function hashPassword(plain: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(plain, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, salt, hash] = parts;
  const expected = Buffer.from(hash!, "hex");
  const got = scryptSync(plain, salt!, 64);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

// ── Users ─────────────────────────────────────────────────────
export interface User {
  id: string;
  email: string;
}

/** Create a user. Throws on duplicate email (unique constraint). */
export function createUser(email: string, password: string): User {
  const id = randomUUID();
  const e = normalizeEmail(email);
  db.prepare(
    "INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)"
  ).run(id, e, hashPassword(password), now());
  return { id, email: e };
}

export function getUserByEmail(email: string): { id: string; email: string; password_hash: string } | undefined {
  return db.prepare("SELECT id, email, password_hash FROM users WHERE email = ?").get(normalizeEmail(email)) as any;
}

export function getUserById(id: string): User | undefined {
  return db.prepare("SELECT id, email FROM users WHERE id = ?").get(id) as any;
}

export function setUserPassword(userId: string, password: string): void {
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(password), userId);
}

export function touchUserLogin(userId: string): void {
  db.prepare("UPDATE users SET last_login = ? WHERE id = ?").run(now(), userId);
}

// ── Memberships ───────────────────────────────────────────────
export function addMembership(userId: string, workspaceId: string, role: Role): void {
  db.prepare(
    `INSERT INTO memberships (user_id, workspace_id, role, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, workspace_id) DO UPDATE SET role = excluded.role`
  ).run(userId, workspaceId, role, now());
}

export function getMembership(userId: string, workspaceId: string): { role: Role; member: string | null } | undefined {
  return db
    .prepare("SELECT role, member FROM memberships WHERE user_id = ? AND workspace_id = ?")
    .get(userId, workspaceId) as any;
}

/** Set the capture identity (the hook's --me) this account uses in a workspace. */
export function setMembershipMember(userId: string, workspaceId: string, member: string | null): boolean {
  const r = db
    .prepare("UPDATE memberships SET member = ? WHERE user_id = ? AND workspace_id = ?")
    .run(member && member.trim() ? member.trim() : null, userId, workspaceId);
  return r.changes > 0;
}

/**
 * The project member id an account acts as in a workspace: its explicit override
 * if set, else its email (the common default, since hooks fall back to git email).
 */
export function effectiveMember(userId: string, workspaceId: string): string | undefined {
  const m = getMembership(userId, workspaceId);
  if (!m) return undefined;
  if (m.member) return m.member;
  return getUserById(userId)?.email;
}

/** Workspaces a user belongs to, with role and name. */
export function listMemberships(userId: string): { id: string; name: string; role: Role }[] {
  // `id` is the workspace id — named to match the Workspace/WorkspaceMembership
  // shape the web client consumes (the switcher reads `.id`).
  return db
    .prepare(
      `SELECT m.workspace_id AS id, w.name AS name, m.role AS role
       FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
       WHERE m.user_id = ? ORDER BY m.created_at`
    )
    .all(userId) as any;
}

/** Members of a workspace, with email and role. */
export function listMembers(workspaceId: string): { userId: string; email: string; role: Role; createdAt: number }[] {
  return db
    .prepare(
      `SELECT m.user_id AS userId, u.email AS email, m.role AS role, m.created_at AS createdAt
       FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = ? ORDER BY m.created_at`
    )
    .all(workspaceId) as any;
}

export function setMemberRole(userId: string, workspaceId: string, role: Role): boolean {
  const r = db
    .prepare("UPDATE memberships SET role = ? WHERE user_id = ? AND workspace_id = ?")
    .run(role, userId, workspaceId);
  return r.changes > 0;
}

export function removeMembership(userId: string, workspaceId: string): boolean {
  const r = db
    .prepare("DELETE FROM memberships WHERE user_id = ? AND workspace_id = ?")
    .run(userId, workspaceId);
  return r.changes > 0;
}

/** How many owners a workspace has (guard against removing the last owner). */
export function countOwners(workspaceId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = ? AND role = 'owner'")
    .get(workspaceId) as { n: number };
  return row.n;
}

const DAY = 24 * 60 * 60 * 1000;

// ── Invites (link-based, single-use) ──────────────────────────
export function createInvite(
  workspaceId: string,
  role: Role,
  createdBy: string | undefined,
  label?: string,
  ttlDays = 7
): { id: string; code: string } {
  const id = randomUUID();
  const code = `inv_${randomBytes(18).toString("hex")}`;
  db.prepare(
    `INSERT INTO invites (id, workspace_id, role, code_hash, label, created_by, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, workspaceId, role, sha256(code), label ?? null, createdBy ?? null, now() + ttlDays * DAY, now());
  return { id, code };
}

/** Read an invite by code for display (does not consume it). */
export function getInvite(code: string): { workspaceId: string; role: Role; label?: string; valid: boolean } | null {
  const row = db
    .prepare("SELECT workspace_id, role, label, expires_at, accepted_at FROM invites WHERE code_hash = ?")
    .get(sha256(code)) as any;
  if (!row) return null;
  const valid = !row.accepted_at && row.expires_at > now();
  return { workspaceId: row.workspace_id, role: row.role, label: row.label ?? undefined, valid };
}

/** Consume an invite, adding the user to the workspace. Returns the membership or null. */
export function acceptInvite(code: string, userId: string): { workspaceId: string; role: Role } | null {
  const row = db
    .prepare("SELECT id, workspace_id, role, expires_at, accepted_at FROM invites WHERE code_hash = ?")
    .get(sha256(code)) as any;
  if (!row || row.accepted_at || row.expires_at <= now()) return null;
  db.prepare("UPDATE invites SET accepted_by = ?, accepted_at = ? WHERE id = ?").run(userId, now(), row.id);
  addMembership(userId, row.workspace_id, row.role as Role);
  return { workspaceId: row.workspace_id, role: row.role as Role };
}

export function listInvites(workspaceId: string): { id: string; role: Role; label?: string; expiresAt: number; accepted: boolean }[] {
  return db
    .prepare("SELECT id, role, label, expires_at AS expiresAt, accepted_at FROM invites WHERE workspace_id = ? ORDER BY created_at DESC")
    .all(workspaceId)
    .map((r: any) => ({ id: r.id, role: r.role, label: r.label ?? undefined, expiresAt: r.expiresAt, accepted: !!r.accepted_at }));
}

// ── Password resets (link-based, single-use) ──────────────────
export function createReset(userId: string, ttlDays = 7): { code: string } {
  const id = randomUUID();
  const code = `res_${randomBytes(18).toString("hex")}`;
  db.prepare(
    "INSERT INTO password_resets (id, user_id, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(id, userId, sha256(code), now() + ttlDays * DAY, now());
  return { code };
}

/** Consume a reset code and set the new password. Returns true on success. */
export function useReset(code: string, newPassword: string): boolean {
  const row = db
    .prepare("SELECT id, user_id, expires_at, used_at FROM password_resets WHERE code_hash = ?")
    .get(sha256(code)) as any;
  if (!row || row.used_at || row.expires_at <= now()) return false;
  setUserPassword(row.user_id, newPassword);
  db.prepare("UPDATE password_resets SET used_at = ? WHERE id = ?").run(now(), row.id);
  return true;
}
