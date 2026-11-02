import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { createServer as createHttpServer, type Server } from "node:http";

// Real server, real SQLite, auth ON. The test process opens the same DB file to
// seed rows the API has no create route for (pending, handoffs, traits).
const DB_PATH = join(tmpdir(), `reins-security-${randomUUID()}.db`);
process.env.REINS_DB = DB_PATH;
process.env.REINS_AUTH = "on";
process.env.REINS_SESSION_SECRET = "test-secret-security-routes-0123456789";
const db = await import("../db.js");

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createNetServer();
    srv.once("error", rej);
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => res(port));
    });
  });
}

async function waitForHealth(url: string, child: ChildProcess, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early (code ${child.exitCode})`);
    try {
      if ((await fetch(`${url}/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("server did not become healthy in time");
}

// An OpenAI-compatible endpoint that rejects every key — the "bad provider key"
// a user can configure. Real HTTP, so the real client code path runs.
function badKeyLlm(): Promise<{ server: Server; port: number }> {
  return new Promise((done) => {
    const server = createHttpServer((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Incorrect API key provided", type: "invalid_request_error" } }));
    });
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      done({ server, port: typeof a === "object" && a ? a.port : 0 });
    });
  });
}

/** Session-aware client. `ip` rides as X-Forwarded-For (server trusts 1 hop). */
function makeClient(base: string, ip = "10.0.0.1") {
  let cookie = "";
  return {
    get cookie() { return cookie; },
    async call(path: string, init: RequestInit & { bearer?: string } = {}) {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-forwarded-for": ip,
        ...(init.headers as Record<string, string> | undefined),
      };
      if (init.bearer) headers["authorization"] = `Bearer ${init.bearer}`;
      else if (cookie) headers["cookie"] = cookie;
      const r = await fetch(`${base}${path}`, { ...init, headers });
      const setCookie = r.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0]!;
      let body: any = null;
      try { body = await r.json(); } catch { /* none */ }
      return { status: r.status, body };
    },
  };
}

const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });

test("security: tenant isolation, crash safety, roles, identity, and abuse limits", async () => {
  const llm = await badKeyLlm();
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--import", "tsx", resolve(import.meta.dirname, "..", "index.ts")], {
    env: {
      ...process.env,
      PORT: String(port),
      REINS_DB: DB_PATH,
      REINS_AUTH: "on",
      REINS_SESSION_SECRET: process.env.REINS_SESSION_SECRET,
      REINS_TRUST_PROXY: "1",
      REINS_LLM_BASE_URL: `http://127.0.0.1:${llm.port}/v1`,
      REINS_LLM_API_KEY: "sk-bad-key",
      REINS_LLM_MODEL: "test-model",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (d) => process.stderr.write(`[server] ${d}`));

  try {
    await waitForHealth(url, child);
    const uid = randomUUID().slice(0, 8);
    const signup = async (c: ReturnType<typeof makeClient>, email: string, name: string) => {
      const r = await c.call("/api/auth/signup", post({ email, password: "supersecret-1", workspaceName: name }));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      // Signup mints no machine tokens; the owner mints the ones the test uses.
      const mint = async (kind: string) => (await c.call("/api/admin/tokens", post({ kind }))).body.token as string;
      return { ...r.body, tokens: { ingest: await mint("ingest"), access: await mint("access"), admin: await mint("admin") } } as { workspace: { id: string }; tokens: { ingest: string; access: string; admin: string } };
    };
    const ownerA = makeClient(url, "10.0.1.1");
    const emailA = `a-${uid}@acme.test`;
    const A = await signup(ownerA, emailA, "Acme");
    const ownerB = makeClient(url, "10.0.1.2");
    const B = await signup(ownerB, `b-${uid}@beta.test`, "Beta");

    // ── 1) Cross-tenant ingest is refused, with a message the hook can show ──
    const ingestA = await ownerA.call("/api/ingest", { ...post({ project: "shared-proj", member: "asha", text: "starting the auth refactor" }), bearer: A.tokens.ingest });
    assert.equal(ingestA.status, 200, JSON.stringify(ingestA.body));
    const ingestB = await ownerB.call("/api/ingest", { ...post({ project: "shared-proj", member: "mallory", text: "planted text" }), bearer: B.tokens.ingest });
    assert.equal(ingestB.status, 403, "B's token must not write into A's project");
    assert.match(ingestB.body.error, /belongs to another workspace/);
    const snapA = await ownerA.call("/api/projects/shared-proj", { bearer: A.tokens.access });
    assert.deepEqual(snapA.body.members.map((m: any) => m.member), ["asha"], "nothing of B's landed on A's board");

    // ── 2) A failing provider makes the rollup return an error, not crash ──
    const rollup = await ownerA.call("/api/projects/shared-proj/rollup", { method: "POST" });
    assert.equal(rollup.status, 502, JSON.stringify(rollup.body));
    assert.match(rollup.body.error, /rollup failed/);
    assert.equal((await fetch(`${url}/health`)).status, 200, "server is still up");
    assert.equal(child.exitCode, null);

    // ── Scoped context route (used by the HTTP MCP) is tenant-checked ──
    const ctx = await ownerA.call("/api/projects/shared-proj/context?query=auth&limit=200", { bearer: A.tokens.access });
    assert.equal(ctx.status, 200);
    assert.match(ctx.body.context, /shared context/);
    assert.equal((await ownerB.call("/api/projects/shared-proj/context", { bearer: B.tokens.access })).status, 404);

    // ── 9) Id-only updates: ids from another project/tenant never match ──
    db.ensureProject("b-proj", "B project", B.workspace.id);
    const idA = db.upsertPending("shared-proj", "asha", "write the migration");
    const idB = db.upsertPending("b-proj", "bob", "B's private task");
    const cross = await ownerA.call(`/api/pending/${idB}/claim`, post({ project: "shared-proj", by: "asha" }));
    assert.equal(cross.status, 409, "B's item can't be claimed via A's project");
    assert.equal((await ownerA.call(`/api/pending/${idB}/done`, post({ project: "shared-proj" }))).status, 404);
    assert.equal(db.listPending("b-proj")[0].status, "open", "B's item untouched");
    assert.equal((await ownerA.call(`/api/pending/${idA}/claim`, post({ project: "shared-proj", by: "asha" }))).status, 200);
    assert.equal((await ownerA.call(`/api/pending/${idA}/claim`, post({ project: "shared-proj", by: "rui" }))).status, 409, "claim is atomic");
    assert.equal(db.listPending("shared-proj")[0].claimed_by, "asha", "first claimer keeps it");
    db.createHandoff({ project: "b-proj", toMember: "bob", fromMember: "x", kind: "mention", text: "B-only handoff" });
    const hB = db.listHandoffs("b-proj")[0].id;
    assert.equal((await ownerA.call(`/api/handoffs/${hB}/resolve`, post({ project: "shared-proj" }))).status, 404);
    assert.equal(db.listHandoffs("b-proj").length, 1, "B's handoff still open");

    // Token revoke is workspace-scoped.
    const bTokens = (await ownerB.call("/api/admin/tokens")).body.tokens as { id: string; kind: string }[];
    const bAccessId = bTokens.find((t) => t.kind === "access")!.id;
    assert.equal((await ownerA.call(`/api/admin/tokens/${bAccessId}/revoke`, { method: "POST" })).status, 404);
    assert.equal((await ownerB.call("/api/projects", { bearer: B.tokens.access })).status, 200, "B's token still works");

    // ── 6) A token-derived session dies when its token is revoked ──
    const viewer = makeClient(url, "10.0.1.3");
    assert.equal((await viewer.call("/api/auth/session", post({ token: A.tokens.access }))).status, 200);
    assert.equal((await viewer.call("/api/projects")).status, 200);
    const aAccessId = ((await ownerA.call("/api/admin/tokens")).body.tokens as any[]).find((t) => t.kind === "access").id;
    assert.equal((await ownerA.call(`/api/admin/tokens/${aAccessId}/revoke`, { method: "POST" })).status, 200);
    assert.equal((await viewer.call("/api/projects")).status, 401, "session ended with its token");

    // ── 7) Only an owner hands out or takes away ownership ──
    const inv = await ownerA.call(`/api/workspaces/${A.workspace.id}/invites`, post({ role: "admin" }));
    assert.equal(inv.status, 200);
    const adminC = makeClient(url, "10.0.1.4");
    await signup(adminC, `c-${uid}@acme.test`, "C's own");
    assert.equal((await adminC.call("/api/auth/join", post({ code: inv.body.code }))).status, 200);
    assert.equal((await adminC.call("/api/auth/switch", post({ workspaceId: A.workspace.id }))).status, 200);
    const members = (await ownerA.call(`/api/workspaces/${A.workspace.id}/members`)).body.members as any[];
    const aId = members.find((m) => m.email === emailA).userId;
    const cId = members.find((m) => m.role === "admin").userId;
    const W = `/api/workspaces/${A.workspace.id}`;
    assert.equal((await adminC.call(`${W}/invites`, post({ role: "owner" }))).status, 403, "admin can't mint owner invites");
    assert.equal((await adminC.call(`${W}/members/${cId}/role`, post({ role: "owner" }))).status, 403, "admin can't self-promote");
    assert.equal((await adminC.call(`${W}/members/${aId}/role`, post({ role: "member" }))).status, 403, "admin can't demote the owner");
    assert.equal((await adminC.call(`${W}/members/${aId}`, { method: "DELETE" })).status, 403, "admin can't remove the owner");
    assert.equal((await adminC.call(`${W}/invites`, post({ role: "member" }))).status, 200, "admin can still invite members");
    assert.equal((await ownerA.call(`${W}/members/${cId}/role`, post({ role: "owner" }))).status, 200, "owner can grant owner");

    // ── 8) A capture identity can't be claimed twice in a workspace ──
    assert.equal((await adminC.call("/api/auth/member", post({ member: emailA }))).status, 409, "A's default (email) identity is taken");
    assert.equal((await ownerA.call("/api/auth/member", post({ member: "asha" }))).status, 200);
    assert.equal((await adminC.call("/api/auth/member", post({ member: "ASHA" }))).status, 409, "case-insensitive");
    assert.equal((await adminC.call("/api/auth/member", post({ member: "carol" }))).status, 200);

    // Traits are edited only by their owner's signed-in account, not a bare token.
    db.applyTraitOps("shared-proj", "asha", [{ op: "add", type: "quality", statement: "prefers real tests", evidence: "x" }]);
    const traitId = db.buildProfileView("shared-proj", "asha")[0]!.id;
    const patch = (c: ReturnType<typeof makeClient>, bearer?: string) =>
      c.call(`/api/traits/${traitId}`, { method: "PATCH", body: JSON.stringify({ statement: "prefers integration tests" }), bearer });
    assert.equal((await patch(ownerA, A.tokens.admin)).status, 403, "a token carries no identity");
    assert.equal((await patch(adminC)).status, 403, "another teammate can't edit it");
    assert.equal((await patch(ownerA)).status, 200, "the owner can");

    // ── 10) Abuse limits ──
    // Duplicate-email signups count toward the per-IP limit (no free enumeration).
    const prober = makeClient(url, "10.9.9.9");
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      codes.push((await prober.call("/api/auth/signup", post({ email: emailA, password: "anything-123" }))).status);
    }
    assert.deepEqual(codes, [409, 409, 409, 409, 409, 429]);
    // Failed logins lock out (IP, email) — not the account for everyone.
    const attacker = makeClient(url, "10.6.6.6");
    for (let i = 0; i < 8; i++) {
      assert.equal((await attacker.call("/api/auth/login", post({ email: emailA, password: "wrong-password" }))).status, 401);
    }
    assert.equal((await attacker.call("/api/auth/login", post({ email: emailA, password: "wrong-password" }))).status, 429);
    const realUser = makeClient(url, "10.0.2.2");
    assert.equal((await realUser.call("/api/auth/login", post({ email: emailA, password: "supersecret-1" }))).status, 200, "the owner can still log in from their own IP");
  } finally {
    child.kill("SIGTERM");
    llm.server.close();
  }
});
