/**
 * Device login for the `reins-hook` setup wizard (an OAuth device-flow shape).
 * The terminal asks for a login and gets a secret deviceCode plus a short
 * userCode; the person opens /cli?code=<userCode> while signed in, picks or
 * creates the project, and approves; the terminal's poll then receives an
 * ingest token for that workspace exactly once. Nobody copies tokens around.
 *
 * Only the deviceCode's sha256 is stored, and the token is minted at the single
 * successful poll, so no usable credential ever sits in the table.
 */
import { Router } from "express";
import type { Request, Response } from "express";
import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { z } from "zod";
import { db, now, ensureProject, projectWorkspace, getProject, listProjects } from "../db.js";
import { env } from "../env.js";
import { getWorkspace, getUserById, getMembership, mintToken } from "../auth.js";
import { requireUser, counterMap, overLimit } from "../middleware.js";
import { clientIp } from "./auth.js";

export const cli = Router();

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// Public endpoints, so bounded: a person runs the wizard a few times at most, a
// polling terminal asks every `interval` seconds. Lookups by userCode are capped
// per account so a signed-in user can't sweep the code space for someone else's
// pending login (31^8 codes, each live for 10 minutes).
const LOGIN_MAX = 20; // logins started per IP per window
const LOGIN_WINDOW_MS = 10 * 60_000;
const POLL_MIN_GAP_MS = 1000; // faster than ~1/s → slow_down
const POLL_INTERVAL_S = 2;
const LOOKUP_MAX_PER_MIN = 60; // GET/approve/deny per account (the page may re-read status)
const loginHits = counterMap();
const pollHits = counterMap();
const lookupHits = counterMap();

// No 0/O, 1/I/L: the code is read off one screen and typed or compared on another.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LEN = 8;

type Status = "pending" | "approved" | "denied" | "consumed";
interface LoginRow {
  id: string;
  user_code: string;
  host: string | null;
  repo: string | null;
  wanted_project: string | null;
  status: Status;
  workspace_id: string | null;
  user_id: string | null;
  project: string | null;
  member: string | null;
  expires_at: number;
}

const displayCode = (c: string) => `${c.slice(0, 4)}-${c.slice(4)}`;

/** "abcd-efgh", "ABCDEFGH", " abcd efgh " → "ABCDEFGH"; null if it can't be a code. */
function normalizeCode(raw: string): string | null {
  const c = raw.toUpperCase().replace(/[\s-]/g, "");
  if (c.length !== CODE_LEN || [...c].some((ch) => !CODE_ALPHABET.includes(ch))) return null;
  return c;
}

function newUserCode(): string {
  // Unique among live logins; with ~8.5e11 codes a retry is already vanishingly rare.
  const live = db.prepare("SELECT 1 FROM cli_logins WHERE user_code = ? AND expires_at > ?");
  for (;;) {
    let c = "";
    for (let i = 0; i < CODE_LEN; i++) c += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    if (!live.get(c, now())) return c;
  }
}

/** Project-id slug, same shape POST /api/projects accepts. "" if nothing usable. */
function slugify(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}

/** "github.com/acme/Checkout-V2.git", "/home/a/checkout-v2" → "checkout-v2". */
function repoSlug(repo: string | null): string {
  if (!repo) return "";
  const last = repo.replace(/[\\/]+$/, "").split(/[\\/:]/).pop() ?? "";
  return slugify(last.replace(/\.git$/i, ""));
}

/** A free global project id for a new project named `name`. */
function freeProjectId(name: string): string {
  const base = slugify(name) || "project";
  if (!projectWorkspace(base)) return base;
  for (;;) {
    const id = `${base.slice(0, 59)}-${randomBytes(2).toString("hex")}`;
    if (!projectWorkspace(id)) return id;
  }
}

/** The live row for a userCode (the newest, should an expired one share it), or
 *  responds 404 / 429 and returns null. */
function findByCode(req: Request, res: Response): LoginRow | null {
  if (overLimit(lookupHits, req.userId!, LOOKUP_MAX_PER_MIN, 60_000)) {
    res.status(429).json({ error: "too many attempts, please wait a minute" });
    return null;
  }
  const code = normalizeCode(String(req.params.userCode ?? ""));
  const row = code
    ? (db.prepare("SELECT * FROM cli_logins WHERE user_code = ? ORDER BY created_at DESC LIMIT 1").get(code) as LoginRow | undefined)
    : undefined;
  if (!row) {
    res.status(404).json({ error: "unknown code" });
    return null;
  }
  return row;
}

const expired = (row: LoginRow) => row.expires_at <= now();

/** Approve/deny apply only to a live, pending login: 410 expired, 409 otherwise. */
function assertPending(row: LoginRow, res: Response): boolean {
  if (row.status === "pending" && expired(row)) {
    res.status(410).json({ error: "this login has expired, run the command again" });
    return false;
  }
  if (row.status !== "pending") {
    res.status(409).json({ error: `this login was already ${row.status}` });
    return false;
  }
  return true;
}

// Start a login (the terminal). Public; there is nothing to log into when the
// instance runs without accounts, and the CLI skips this step on that answer.
cli.post("/cli/login", (req, res) => {
  if (!env.authEnabled) return res.status(400).json({ error: "auth is off" });
  if (overLimit(loginHits, clientIp(req), LOGIN_MAX, LOGIN_WINDOW_MS)) {
    return res.status(429).json({ error: "too many logins started, please wait a few minutes" });
  }
  const body = z
    .object({
      host: z.string().trim().max(120).optional(),
      repo: z.string().trim().max(200).optional(),
      // The project the terminal was pointed at (--project), so the approve page preselects it.
      project: z.string().trim().max(120).optional(),
    })
    .safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: body.error.issues });
  const deviceCode = randomBytes(32).toString("base64url");
  const userCode = newUserCode();
  db.prepare(
    `INSERT INTO cli_logins (id, device_hash, user_code, host, repo, wanted_project, status, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).run(randomUUID(), sha256(deviceCode), userCode, body.data.host || null, body.data.repo || null, body.data.project || null, now() + env.cliLoginTtlMs, now());
  res.json({
    deviceCode,
    userCode: displayCode(userCode),
    verifyPath: `/cli?code=${displayCode(userCode)}`,
    expiresIn: Math.round(env.cliLoginTtlMs / 1000),
    interval: POLL_INTERVAL_S,
  });
});

// What the approve page shows: the terminal's machine and repo, and the
// signed-in account's workspace projects to pick from.
cli.get("/cli/login/:userCode", requireUser, (req, res) => {
  const row = findByCode(req, res);
  if (!row) return;
  const live = row.status === "pending" || row.status === "approved";
  const ws = getWorkspace(req.workspaceId!);
  res.json({
    userCode: displayCode(row.user_code),
    host: row.host,
    repo: row.repo,
    status: live && expired(row) ? "expired" : row.status,
    expiresAt: row.expires_at,
    workspace: { id: req.workspaceId!, name: ws?.name ?? "" },
    projects: listProjects(req.workspaceId!).map((p) => ({ id: p.id, name: p.name })),
    suggestedProject: row.wanted_project || repoSlug(row.repo),
  });
});

// Approve: bind the login to the caller's workspace, a project in it (existing
// or created now), and the caller's capture identity.
cli.post("/cli/login/:userCode/approve", requireUser, (req, res) => {
  const body = z
    .object({
      project: z.string().trim().min(1).max(120).optional(),
      newProject: z.object({ name: z.string().trim().min(1).max(80) }).optional(),
    })
    .refine((b) => !!b.project !== !!b.newProject, "send exactly one of project or newProject")
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues });
  const row = findByCode(req, res);
  if (!row || !assertPending(row, res)) return;
  const ws = req.workspaceId!;

  let projectId: string;
  if (body.data.project) {
    projectId = body.data.project;
    // Another workspace's project (or none at all): 404 either way, so the
    // answer doesn't reveal that the id exists elsewhere.
    if (projectWorkspace(projectId) !== ws) return res.status(404).json({ error: "project not found" });
  } else {
    projectId = freeProjectId(body.data.newProject!.name);
  }

  // The member the hook will report as: the account's identity in this workspace
  // (its email unless it set an override), so the board shows the right person.
  const member = req.member ?? getUserById(req.userId!)?.email ?? req.userId!;
  // Synchronous, so nothing can slip between the pending check and this update;
  // the WHERE re-checks anyway and the transaction keeps project + approval together.
  const approved = db.transaction(() => {
    const won = db
      .prepare(
        `UPDATE cli_logins SET status = 'approved', workspace_id = ?, user_id = ?, project = ?, member = ?, approved_at = ?
          WHERE id = ? AND status = 'pending' AND expires_at > ?`
      )
      .run(ws, req.userId!, projectId, member, now(), row.id, now()).changes > 0;
    if (won && body.data.newProject) ensureProject(projectId, body.data.newProject.name, ws);
    return won;
  })();
  if (!approved) return res.status(409).json({ error: "this login is no longer pending" });
  const p = getProject(projectId);
  res.json({ ok: true, project: { id: p.id, name: p.name } });
});

cli.post("/cli/login/:userCode/deny", requireUser, (req, res) => {
  const row = findByCode(req, res);
  if (!row || !assertPending(row, res)) return;
  db.prepare("UPDATE cli_logins SET status = 'denied' WHERE id = ? AND status = 'pending'").run(row.id);
  res.json({ ok: true });
});

// The terminal's poll. Public: holding the deviceCode is the credential. An
// approved login hands out its token exactly once, then reads as expired.
cli.post("/cli/poll", (req, res) => {
  const body = z.object({ deviceCode: z.string().min(1).max(100) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues });
  const hash = sha256(body.data.deviceCode);
  if (overLimit(pollHits, hash, 1, POLL_MIN_GAP_MS)) return res.status(429).json({ status: "slow_down" });
  const row = db.prepare("SELECT * FROM cli_logins WHERE device_hash = ?").get(hash) as LoginRow | undefined;
  if (!row || row.status === "consumed" || expired(row)) return res.status(410).json({ status: "expired" });
  if (row.status === "pending" || row.status === "denied") return res.json({ status: row.status });

  // Approved. Removed from the workspace since approving? Then no token.
  if (!getMembership(row.user_id!, row.workspace_id!)) {
    db.prepare("UPDATE cli_logins SET status = 'denied' WHERE id = ?").run(row.id);
    return res.json({ status: "denied" });
  }
  const email = getUserById(row.user_id!)?.email ?? row.member!;
  const token = db.transaction(() => {
    const won = db
      .prepare("UPDATE cli_logins SET status = 'consumed', consumed_at = ? WHERE id = ? AND status = 'approved'")
      .run(now(), row.id).changes > 0;
    return won ? mintToken(row.workspace_id!, "ingest", ["cli", email, row.host].filter(Boolean).join(" · ")) : null;
  })();
  if (!token) return res.status(410).json({ status: "expired" });
  const p = getProject(row.project!);
  const ws = getWorkspace(row.workspace_id!);
  res.json({
    status: "approved",
    token,
    member: row.member,
    project: { id: row.project, name: p?.name ?? row.project },
    workspace: { id: row.workspace_id, name: ws?.name ?? "" },
  });
});
