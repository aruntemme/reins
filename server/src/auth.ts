import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { db, now } from "./db.js";
import { env } from "./env.js";

export type TokenKind = "ingest" | "access" | "admin";

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

export function verifySession(cookie: string | undefined): { workspaceId: string; kind: TokenKind } | null {
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
