import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { createServer as createHttpServer, type Server } from "node:http";

// Real server (auth ON), real SQLite, real HTTP. The LLM is a local
// OpenAI-compatible stub that calls every event noise and returns an empty
// rollup, so nothing here depends on a model: touches, the pre-edit check, the
// injected pack, lead actions, git state and auto-closing are all deterministic.
const DB_PATH = join(tmpdir(), `reins-hookfeat-${randomUUID()}.db`);
process.env.REINS_DB = DB_PATH;
process.env.REINS_AUTH = "on";
process.env.REINS_SESSION_SECRET = "test-secret-hook-features-0123456789";
const db = await import("../db.js");

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createNetServer();
    srv.once("error", rej);
    srv.listen(0, () => {
      const a = srv.address();
      const port = typeof a === "object" && a ? a.port : 0;
      srv.close(() => res(port));
    });
  });
}

function llmStub(): Promise<{ server: Server; port: number }> {
  return new Promise((done) => {
    const server = createHttpServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const content = JSON.stringify({ significance: "noise", summary: "s", alignment: "a", collisions: [], risks: [], handoffs: [] });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "x", object: "chat.completion", created: 0, model: "m", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      done({ server, port: typeof a === "object" && a ? a.port : 0 });
    });
  });
}

async function waitForHealth(url: string, child: ChildProcess, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early (code ${child.exitCode})`);
    try { if ((await fetch(`${url}/health`)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("server did not become healthy in time");
}

function makeClient(base: string, ip: string) {
  let cookie = "";
  return {
    async call(path: string, init: RequestInit & { bearer?: string; key?: string } = {}) {
      const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": ip };
      if (init.bearer) headers["authorization"] = `Bearer ${init.bearer}`;
      else if (init.key) headers["x-reins-key"] = init.key; // exactly how the hook authenticates
      else if (cookie) headers["cookie"] = cookie;
      const r = await fetch(`${base}${path}`, { ...init, headers });
      const sc = r.headers.get("set-cookie");
      if (sc) cookie = sc.split(";")[0]!;
      let body: any = null;
      try { body = await r.json(); } catch { /* none */ }
      return { status: r.status, body };
    },
  };
}
const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
const put = (body: unknown) => ({ method: "PUT", body: JSON.stringify(body) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TOUCH_WINDOW_MS = 2500;

test("hook features: touches, pre-edit check, pack deltas, lead actions, git, auto-close, privacy, opt-in", async () => {
  const llm = await llmStub();
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
      REINS_LLM_API_KEY: "sk-test",
      REINS_LLM_MODEL: "test-model",
      REINS_TOUCH_WINDOW_MS: String(TOUCH_WINDOW_MS),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (d) => process.stderr.write(`[server] ${d}`));

  try {
    await waitForHealth(url, child);
    const uid = randomUUID().slice(0, 8);
    const owner = makeClient(url, "10.1.0.1");
    const signup = async (c: ReturnType<typeof makeClient>, email: string, name: string) => {
      const r = await c.call("/api/auth/signup", post({ email, password: "supersecret-1", workspaceName: name }));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      // Signup mints no machine tokens; the owner mints the ones the test uses.
      const mint = async (kind: string) => (await c.call("/api/admin/tokens", post({ kind }))).body.token as string;
      return { ...r.body, tokens: { ingest: await mint("ingest"), access: await mint("access"), admin: await mint("admin") } } as { workspace: { id: string }; tokens: { ingest: string; access: string; admin: string } };
    };
    const A = await signup(owner, `lead-${uid}@acme.test`, "Acme");
    const other = makeClient(url, "10.1.0.2");
    const B = await signup(other, `b-${uid}@beta.test`, "Beta");
    const P = `proj-${uid}`;
    const key = A.tokens.ingest;
    assert.equal((await owner.call("/api/projects", post({ id: P, name: "Demo" }))).status, 200);
    assert.equal((await owner.call(`/api/projects/${P}/goal`, put({ goal: "Ship OAuth login" }))).status, 200);
    // The lead's account acts as "asha" (so the opt-in below is hers).
    assert.equal((await owner.call("/api/auth/member", post({ member: "asha" }))).status, 200);

    // ── auth on the hook endpoints ──
    assert.equal((await other.call("/api/hook/touch", post({ project: P, member: "x", path: "a.ts" }))).status, 401, "no token");
    assert.equal((await other.call("/api/hook/touch", { ...post({ project: P, member: "x", path: "a.ts" }), key: B.tokens.ingest })).status, 403, "another workspace can't write");
    assert.equal((await owner.call("/api/hook/touch", { ...post({ project: P, member: "asha", path: "/home/asha/src/a.ts" }), key })).status, 400, "absolute paths refused");
    assert.equal((await owner.call("/api/hook/touch", { ...post({ project: P, member: "asha", path: "../etc/passwd" }), key })).status, 400, "no escaping the repo");

    // ── feature 2: a real touch, then a teammate's pre-edit check ──
    const ingest = (member: string, text: string, meta?: unknown, kind = "progress") =>
      owner.call("/api/ingest", { ...post({ project: P, member, text, kind, meta }), key });
    assert.equal((await ingest("ravi", "starting on the login page")).status, 200);
    const t1 = await owner.call("/api/hook/touch", { ...post({ project: P, member: "asha", displayName: "Asha", path: "src/auth/session.ts", tool: "Edit" }), key });
    assert.equal(t1.status, 200, JSON.stringify(t1.body));
    const chk = await owner.call("/api/hook/check", { ...post({ project: P, member: "ravi", path: "src/auth/session.ts" }), key });
    assert.equal(chk.status, 200);
    assert.equal(chk.body.warnings.length, 1);
    assert.match(chk.body.text, /Asha edited src\/auth\/session\.ts/);
    assert.match(chk.body.text, /not blocked/);
    assert.equal((await owner.call("/api/hook/check", { ...post({ project: P, member: "asha", path: "src/auth/session.ts" }), key })).body.text, "", "your own touch never warns you");
    const leak = await other.call("/api/hook/check", { ...post({ project: P, member: "ravi", path: "src/auth/session.ts" }), key: B.tokens.ingest });
    assert.equal(leak.status, 200);
    assert.equal(leak.body.text, "", "another workspace's token learns nothing");

    // ── feature 1: start pack, then silence until something relevant changes ──
    const pack = (member: string, mode: "start" | "delta", seen: string[] = [], query?: string) =>
      owner.call("/api/hook/pack", { ...post({ project: P, member, mode, seen, query }), key });
    const start = await pack("ravi", "start");
    assert.equal(start.status, 200);
    assert.match(start.body.text, /Reins team context for "Demo"/);
    assert.match(start.body.text, /Project goal: Ship OAuth login/);
    assert.match(start.body.text, /Asha \[active\]/);
    assert.ok(start.body.text.length <= 1200, `start pack is capped (${start.body.text.length} chars)`);
    let seen: string[] = start.body.shown;
    const quiet = await pack("ravi", "delta", seen);
    assert.equal(quiet.body.text, "", "nothing changed → no injection");
    assert.equal(quiet.body.version, start.body.version);

    // Ravi edits the same file: both now collide (feature 2 + 4) and Ravi's delta says so.
    await owner.call("/api/hook/touch", { ...post({ project: P, member: "ravi", path: "src/auth/session.ts", tool: "Write" }), key });
    const snap1 = (await owner.call(`/api/projects/${P}`, { bearer: A.tokens.access })).body;
    assert.deepEqual(snap1.collisions.map((c: any) => c.area), ["src/auth/session.ts"], "collision shows on the board immediately");
    const openColl = () => db.listHandoffs(P).filter((h: any) => h.kind === "collision");
    assert.equal(openColl().length, 2, "a collision handoff to each, before any rollup");
    const d1 = await pack("ravi", "delta", seen);
    assert.match(d1.body.text, /Reins update/);
    assert.match(d1.body.text, /Collision from Asha|also on src\/auth\/session\.ts/);
    seen = [...seen, ...d1.body.shown];

    // ── feature 6: a lead directive + an assignment reach Ravi's next turn ──
    const asAccess = { bearer: A.tokens.access };
    assert.equal((await owner.call(`/api/projects/${P}/directives`, { ...post({ text: "nope", targets: [] }), ...asAccess })).status, 403, "an access token isn't a lead");
    assert.equal((await owner.call(`/api/projects/${P}/directives`, post({ text: "x", targets: ["nobody"] }))).status, 400, "unknown target refused");
    const dir = await owner.call(`/api/projects/${P}/directives`, post({ text: "Freeze schema changes until the migration lands", targets: ["ravi"], ttlHours: 4 }));
    assert.equal(dir.status, 200, JSON.stringify(dir.body));
    const asg = await owner.call(`/api/projects/${P}/assignments`, post({ area: "src/billing", member: "asha", note: "she owns the Stripe work" }));
    assert.equal(asg.status, 200, JSON.stringify(asg.body));
    const d2 = await pack("ravi", "delta", seen, "update the billing invoice email");
    assert.match(d2.body.text, /Lead directive \(to you\) from asha: Freeze schema changes/);
    assert.match(d2.body.text, /src\/billing is assigned to Asha by the lead/);
    seen = [...seen, ...d2.body.shown];
    assert.equal((await pack("ravi", "delta", seen)).body.text, "", "shown once, then quiet");
    const ashaStart = await pack("asha", "start");
    assert.doesNotMatch(ashaStart.body.text, /Freeze schema/, "a targeted directive stays with its target");
    assert.match(ashaStart.body.text, /Assigned to you by the lead \(asha\): src\/billing/);
    const chk2 = await owner.call("/api/hook/check", { ...post({ project: P, member: "ravi", path: "src/billing/invoice.ts" }), key });
    assert.match(chk2.body.text, /src\/billing is assigned to Asha by the lead/, "the pre-edit check respects the assignment");
    // Readable by both MCP paths (the HTTP MCP uses /context and member detail).
    const ctx = (await owner.call(`/api/projects/${P}/context`, asAccess)).body.context as string;
    assert.match(ctx, /## Lead directives[\s\S]*Freeze schema/);
    assert.match(ctx, /## Assignments[\s\S]*src\/billing → Asha/);
    const raviDetail = (await owner.call(`/api/projects/${P}/members/ravi`, asAccess)).body;
    assert.equal(raviDetail.directives.length, 1, "directive on the targeted member's page");
    // Clearing works and needs a lead.
    assert.equal((await owner.call(`/api/directives/${dir.body.id}/clear`, { ...post({ project: P }), ...asAccess })).status, 403);
    assert.equal((await owner.call(`/api/directives/${dir.body.id}/clear`, post({ project: P }))).status, 200);
    assert.equal((await owner.call(`/api/projects/${P}/members/ravi`, asAccess)).body.directives.length, 0);
    assert.equal((await other.call(`/api/projects/${P}/directives`, post({ text: "x" }))).status, 404, "another workspace's lead can't post here");

    // ── feature 4: the overlap ends → collision handoffs auto-close; reopen sticks ──
    await sleep(TOUCH_WINDOW_MS + 300);
    await owner.call("/api/hook/touch", { ...post({ project: P, member: "ravi", path: "src/ui/button.tsx" }), key });
    assert.equal(openColl().length, 0, "both collision handoffs auto-closed once the touches aged out");
    const closed = db.db.prepare("SELECT * FROM handoffs WHERE project = ? AND kind = 'collision'").all(P) as any[];
    assert.ok(closed.every((h) => h.auto_code === "overlap_ended" && /no longer shared/.test(h.auto_reason)), "reason recorded");
    const toRavi = closed.find((h) => h.to_member === "ravi")!;
    const card = (await owner.call(`/api/projects/${P}`, asAccess)).body.members.find((m: any) => m.member === "ravi");
    assert.equal(card.autoClosed[0].autoClosed.reason.startsWith("overlap ended"), true, "the card shows it as auto-closed");
    assert.equal((await owner.call(`/api/handoffs/${toRavi.id}/reopen`, post({ project: P }))).status, 200);
    await owner.call("/api/hook/touch", { ...post({ project: P, member: "ravi", path: "src/ui/card.tsx" }), key });
    assert.equal(openColl().length, 1, "a reopened handoff isn't auto-closed again for the same reason");
    assert.equal((await owner.call(`/api/handoffs/${toRavi.id}/reopen`, post({ project: P }))).status, 404, "only an auto-closed handoff reopens");

    // ── feature 3: branch on the card, merge settles blockers, privacy hides it ──
    const git = { branch: "feat/oauth", head: "abc1234", defaultBranch: "main", dirty: 2, dirtyFiles: ["src/auth/oauth.ts", "src/auth/session.ts"] };
    await ingest("asha", "wiring the OAuth callback", { git });
    let asha = (await owner.call(`/api/projects/${P}`, asAccess)).body.members.find((m: any) => m.member === "asha");
    assert.equal(asha.git.branch, "feat/oauth");
    assert.equal(asha.git.dirty, 2);
    // Same non-default branch → a collision signal.
    await ingest("ravi", "reviewing oauth", { git: { ...git, dirtyFiles: [], dirty: 0 } });
    const snap2 = (await owner.call(`/api/projects/${P}`, asAccess)).body;
    assert.ok(snap2.collisions.some((c: any) => c.area === "branch feat/oauth"), "two people on one work branch collide");
    // A blocker Ravi waits on, owned by Asha; her work merging settles it.
    db.createHandoff({ project: P, toMember: "asha", fromMember: "ravi", kind: "blocker", text: "Ravi needs the OAuth callback" });
    await ingest("asha", "merged", { git: { branch: "main", head: "def5678", defaultBranch: "main", dirty: 0, dirtyFiles: [], merged: { branch: "feat/oauth", head: "abc1234" } } });
    const blocker = db.db.prepare("SELECT * FROM handoffs WHERE project = ? AND kind = 'blocker'").get(P) as any;
    assert.equal(blocker.status, "resolved");
    assert.equal(blocker.auto_code, "work_merged");
    assert.equal(blocker.auto_reason, "Asha's work merged into the default branch");
    assert.ok(blocker.auto_event, "the triggering event is linked");
    // The text signal: an agent summary reporting a merged PR settles a blocker too.
    db.createHandoff({ project: P, toMember: "ravi", fromMember: "asha", kind: "blocker", text: "Asha waits on Ravi's login page" });
    await ingest("ravi", "Opened the PR; it will be merged once CI passes.", undefined, "summary");
    assert.equal(db.incomingHandoffs(P, "ravi").filter((h: any) => h.kind === "blocker").length, 1, "hedged wording doesn't count");
    await ingest("ravi", "Merged PR #42 for the login page into main.", undefined, "summary");
    assert.equal(db.incomingHandoffs(P, "ravi").filter((h: any) => h.kind === "blocker").length, 0, "a reported merged PR settles it");

    assert.equal((await owner.call("/api/workspace/settings", { ...put({ hideBranches: true }), ...asAccess })).status, 401, "access token can't change settings");
    assert.equal((await owner.call("/api/workspace/settings", put({ hideBranches: true }))).status, 200);
    asha = (await owner.call(`/api/projects/${P}`, asAccess)).body.members.find((m: any) => m.member === "asha");
    assert.equal(asha.git.branch, null, "hidden from teammates");
    await ingest("ravi", "still on oauth", { git: { ...git, dirty: 0, dirtyFiles: [] } });
    await ingest("asha", "back on oauth", { git: { ...git, dirty: 0, dirtyFiles: [] } });
    const snap3 = (await owner.call(`/api/projects/${P}`, asAccess)).body;
    assert.ok(snap3.collisions.some((c: any) => c.area === "the same branch"), "still detected, unnamed");
    assert.doesNotMatch(JSON.stringify(snap3), /feat\/oauth/, "no branch name anywhere in the snapshot");
    assert.doesNotMatch((await pack("ravi", "start")).body.text, /feat\/oauth/, "nor in the agent's pack");
    assert.doesNotMatch((await owner.call(`/api/projects/${P}/context`, asAccess)).body.context, /feat\/oauth/);
    assert.equal((await other.call("/api/workspace/settings")).body.hideBranches, false, "a setting is per workspace");

    // ── feature 5: traits reach agents only after the member opts in ──
    db.db.prepare(
      "INSERT INTO member_traits (id, project, member, type, statement, confidence, observations, evidence, status, first_seen, last_seen) VALUES (?, ?, 'asha', 'quality', 'prefers real database tests over mocks', 0.9, 6, 'x', 'active', ?, ?)"
    ).run(randomUUID(), P, Date.now(), Date.now());
    assert.doesNotMatch((await pack("asha", "start")).body.text, /real database tests/, "off by default");
    const opt = await owner.call("/api/auth/traits-sharing", post({ on: true }));
    assert.equal(opt.body.shareTraits, true);
    assert.equal((await owner.call("/api/auth/me")).body.shareTraits, true);
    assert.match((await pack("asha", "start")).body.text, /Your working conventions[^\n]*prefers real database tests over mocks/);
    // A handoff routed to her carries her relevant conventions.
    const a2 = await owner.call(`/api/projects/${P}/assignments`, post({ area: "src/db", member: "asha", note: "write the database tests" }));
    assert.equal(a2.status, 200);
    const assignH = db.incomingHandoffs(P, "asha").find((h: any) => h.kind === "assignment" && /src\/db/.test(h.text));
    assert.deepEqual(JSON.parse(assignH.conventions), ["prefers real database tests over mocks"]);
    assert.equal((await owner.call("/api/auth/traits-sharing", { ...post({ on: true }), ...asAccess })).status, 401, "only a signed-in member sets their own opt-in");
  } finally {
    child.kill("SIGTERM");
    llm.server.close();
  }
});
