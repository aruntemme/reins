import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { createServer as createHttpServer, type Server } from "node:http";

// Real server (auth ON), real SQLite in a temp file, real HTTP. The LLM is a
// local OpenAI-compatible stub that calls every event noise, so nothing here
// depends on a model: sessions, items, posts, pack delivery and the views are all
// deterministic. The test reads the same SQLite file to check stored rows.
const DB_PATH = join(tmpdir(), `reins-calm-${randomUUID()}.db`);
process.env.REINS_DB = DB_PATH;
process.env.REINS_AUTH = "on";
process.env.REINS_SESSION_SECRET = "test-secret-calm-workspace-0123456789";
const { db } = await import("../db.js");
const { isNoisePrompt, firstLine, captureFrom } = await import("../sessions.js");

const IDLE_MS = 4000;

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
      req.on("data", () => {});
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
    async call(path: string, init: RequestInit & { key?: string } = {}) {
      const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": ip };
      if (init.key) headers["x-reins-key"] = init.key; // how the hook and the MCP authenticate
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
const patch = (body: unknown) => ({ method: "PATCH", body: JSON.stringify(body) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const session = (id: string) => db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as any;

test("noise filter: system-injected and intent-free prompts", () => {
  for (const t of ["", "  ", "ok", "OK!", "Okay.", "yes", "y", "n", "continue", "Go ahead.", "status?", "check now", "thanks!", "proceed", "...",
    "<system-reminder>be nice</system-reminder>", "<task-notification>done</task-notification>", "<command-name>/clear</command-name>",
    "<local-command-stdout>x</local-command-stdout>", "Caveat: The messages below were generated"]) {
    assert.equal(isNoisePrompt(t), true, `noise: ${JSON.stringify(t)}`);
  }
  for (const t of ["fix the login bug", "yes, but use a credit note", "ok so refactor the ledger", "status page is broken"]) {
    assert.equal(isNoisePrompt(t), false, `intent: ${t}`);
  }
  assert.equal(firstLine("## Done\nAdded the webhook handler. Next: tests."), "Done Added the webhook handler.");
  assert.equal(firstLine("token = sk-proj-abcdefghijklmnop1234 is set."), "token = sk-proj-‹redacted› is set.");
  assert.ok(firstLine("x".repeat(400))!.length <= 140);
  // Worktrees and repo roots are kept by folder name only.
  const cap = captureFrom({ session: "s1", meta: { worktree: "/Users/ravi/app/.worktrees/wt-refunds", repo_root: "/Users/ravi/app", git: { branch: "feat/x" } } });
  assert.deepEqual([cap.session, cap.worktree, cap.repoRoot, cap.branch], ["s1", "wt-refunds", "app", "feat/x"]);
});

test("teammate names: a shared display name never resolves to whoever comes first", async () => {
  const { resolveMember, memberCandidates } = await import("../db.js");
  const P = `names-${randomUUID().slice(0, 8)}`;
  const t = Date.now();
  const add = db.prepare("INSERT INTO members (project, member, display_name, last_seen, updated_at) VALUES (?, ?, ?, ?, ?)");
  // Two people whose git user.name is the same (seen for real: a shared repo config).
  add.run(P, "alice@shop.test", "Dev", t, t);
  add.run(P, "bob@shop.test", "Dev", t, t);
  add.run(P, "ravi@shop.test", "Ravi Kumar", t, t);
  assert.equal(resolveMember(P, "Dev"), null, "ambiguous display name");
  assert.deepEqual(memberCandidates(P, "dev").sort(), ["alice@shop.test", "bob@shop.test"]);
  assert.equal(resolveMember(P, "bob@shop.test"), "bob@shop.test", "the member id always resolves");
  assert.equal(resolveMember(P, "@Ravi Kumar"), "ravi@shop.test", "a unique display name still resolves");
  assert.equal(resolveMember(P, "ravi"), "ravi@shop.test", "a unique first name still resolves");
  // The handle before the @, and the board's own "Dev (bob)" label, name one person.
  assert.equal(resolveMember(P, "@bob"), "bob@shop.test", "a member's handle resolves");
  assert.equal(resolveMember(P, "Dev (alice)"), "alice@shop.test", "the board's disambiguated label resolves");
});

test("calm workspace: sessions, items, releases, posts, pack delivery, views, agent API, isolation", async () => {
  const llm = await llmStub();
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--import", "tsx", resolve(import.meta.dirname, "..", "index.ts")], {
    env: {
      ...process.env, PORT: String(port), REINS_DB: DB_PATH, REINS_AUTH: "on", REINS_SESSION_SECRET: process.env.REINS_SESSION_SECRET,
      REINS_TRUST_PROXY: "1", REINS_LLM_BASE_URL: `http://127.0.0.1:${llm.port}/v1`, REINS_LLM_API_KEY: "sk-test", REINS_LLM_MODEL: "test-model",
      REINS_SESSION_IDLE_MS: String(IDLE_MS),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (d) => process.stderr.write(`[server] ${d}`));

  try {
    await waitForHealth(url, child);
    const uid = randomUUID().slice(0, 8);
    const signup = async (c: ReturnType<typeof makeClient>, email: string, workspaceName?: string) => {
      const r = await c.call("/api/auth/signup", post({ email, password: "supersecret-1", workspaceName }));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      // Signup mints no machine tokens; the owner mints the ones the test uses.
      const mint = async (kind: string) => (await c.call("/api/admin/tokens", post({ kind }))).body.token as string;
      return { ...r.body, tokens: { ingest: await mint("ingest"), access: await mint("access"), admin: await mint("admin") } } as { workspace: { id: string }; tokens: { ingest: string; access: string; admin: string } };
    };
    const asha = makeClient(url, "10.2.0.1");
    const A = await signup(asha, `asha-${uid}@acme.test`, "Acme");
    const other = makeClient(url, "10.2.0.2");
    const B = await signup(other, `b-${uid}@beta.test`, "Beta");
    const ravi = makeClient(url, "10.2.0.3");
    await signup(ravi, `ravi-${uid}@acme.test`);
    const inv = await asha.call(`/api/workspaces/${A.workspace.id}/invites`, post({ role: "member" }));
    assert.equal(inv.status, 200, JSON.stringify(inv.body));
    assert.equal((await ravi.call("/api/auth/join", post({ code: inv.body.code }))).status, 200);
    assert.equal((await ravi.call("/api/auth/switch", post({ workspaceId: A.workspace.id }))).status, 200);
    assert.equal((await asha.call("/api/auth/member", post({ member: "asha" }))).status, 200);
    assert.equal((await ravi.call("/api/auth/member", post({ member: "ravi" }))).status, 200);

    const P = `calm-${uid}`;
    assert.equal((await asha.call("/api/projects", post({ id: P, name: "Hyrenet" }))).status, 200);
    const key = A.tokens.ingest;
    const RAVI = { session: "S-ravi-1", source: "codex", branch: "feat/refund", worktree: "/Users/ravi/app/.worktrees/wt-refunds", repo_root: "/Users/ravi/app" };
    const ingest = (member: string, text: string, kind: string, cap: Record<string, string>, event: string) =>
      asha.call("/api/ingest", { ...post({ project: P, member, text, kind, ...cap, meta: { event, ...cap } }), key });
    const agentPost = (path: string, body: Record<string, unknown>, k = key) => asha.call(`/api/agent${path}`, { ...post({ project: P, ...body }), key: k });
    const pack = (member: string, cap: Record<string, string>, mode: "start" | "delta", seen: string[] = [], event = "UserPromptSubmit") =>
      asha.call("/api/hook/pack", { ...post({ project: P, member, mode, seen, event, ...cap }), key });
    const eventCount = () => (db.prepare("SELECT COUNT(*) AS n FROM events WHERE project = ?").get(P) as { n: number }).n;
    const since = Date.now() - 60 * 60_000;

    // ── capture → session upsert, noise filter, marks, Stop ──
    const e1 = await ingest("ravi", "Wire the refund webhook", "intent", RAVI, "UserPromptSubmit");
    assert.equal(e1.status, 200, JSON.stringify(e1.body));
    assert.ok(e1.body.eventId);
    let s = session("S-ravi-1");
    assert.equal(s.state, "working");
    assert.deepEqual([s.project, s.member, s.source, s.branch, s.worktree, s.repo_root], [P, "ravi", "codex", "feat/refund", "wt-refunds", "app"]);
    const before = eventCount();
    for (const noise of ["ok", "continue", "<system-reminder>context</system-reminder>"]) {
      const r = await ingest("ravi", noise, "intent", RAVI, "UserPromptSubmit");
      assert.equal(r.status, 200);
      assert.equal(r.body.ignored, "noise");
      assert.equal(r.body.eventId, null);
    }
    assert.equal(eventCount(), before, "noise prompts are not stored as pipeline events");
    assert.equal((await asha.call("/api/hook/touch", { ...post({ project: P, member: "ravi", path: "billing/webhooks/refund.ts", tool: "Edit", ...RAVI }), key })).status, 200);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM session_marks WHERE session_id = 'S-ravi-1' AND kind = 'edit'").get() as any).n, 1);
    await ingest("ravi", "Agent work in progress", "summary", RAVI, "SubagentStop");
    assert.equal(session("S-ravi-1").state, "working", "a subagent finishing is not the agent stopping");
    await ingest("ravi", "## Summary\nAdded the webhook handler. Next I will add tests.", "summary", RAVI, "Stop");
    s = session("S-ravi-1");
    assert.equal(s.state, "idle");
    assert.equal(s.last_line, "Summary Added the webhook handler.");
    // An adapter without a session id gets the source:member:worktree fallback.
    await ingest("ravi", "aider: refactor ledger", "intent", { source: "aider", worktree: "/Users/ravi/app" }, "");
    assert.equal(session("aider:ravi:app")?.state, "working");
    // …which an agent can name with the full path, as the MCP's attach does.
    assert.equal((await asha.call("/api/agent/sessions/aider%3Aravi%3A%2FUsers%2Fravi%2Fapp/attach", { ...post({ project: P, member: "ravi", itemId: null }), key })).status, 200);

    // ── items, auto-attach by branch, steps, releases, isolation ──
    const created = await ravi.call(`/api/projects/${P}/items`, post({ title: "Refunds", kind: "feature", steps: ["Verify signature", "Idempotency", "Partial refunds"], branch: "feat/refund" }));
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const item = created.body.item;
    assert.equal(item.owner.member, "ravi");
    assert.equal(item.steps.length, 3);
    await ingest("ravi", "Now handle partial refunds", "intent", RAVI, "UserPromptSubmit");
    assert.equal(session("S-ravi-1").item_id, item.id, "the session on the item's branch auto-attaches");
    assert.equal((db.prepare("SELECT status FROM goals WHERE id = ?").get(item.id) as any).status, "doing");
    // Edits after attaching count as the item's files (the earlier one predates it).
    assert.equal((await asha.call("/api/hook/touch", { ...post({ project: P, member: "ravi", path: "billing/ledger.ts", tool: "Edit", ...RAVI }), key })).status, 200);
    // Test runs are marks too, passed or failed; they never count as the item's files.
    assert.equal((await asha.call("/api/hook/run", { ...post({ project: P, member: "ravi", command: "npm test", ok: true, ...RAVI }), key })).status, 200);
    assert.equal((await asha.call("/api/hook/run", { ...post({ project: P, member: "ravi", command: "npm test -- refund", ok: false, ...RAVI }), key })).status, 200);
    assert.deepEqual(
      db.prepare("SELECT kind, path FROM session_marks WHERE session_id = 'S-ravi-1' AND kind LIKE 'test%' ORDER BY at, rowid").all(),
      [{ kind: "test", path: "npm test" }, { kind: "test_fail", path: "npm test -- refund" }],
    );
    assert.equal((await other.call(`/api/projects/${P}/today`)).status, 404, "another workspace can't read");
    assert.equal((await other.call(`/api/items/${item.id}`, patch({ title: "x" }))).status, 404, "or write an item");
    assert.equal((await other.call(`/api/projects/${P}/items`, post({ title: "x", kind: "bug" }))).status, 404);
    assert.equal((await other.call(`/api/projects/${P}/items/${item.id}`)).status, 404);
    assert.equal((await ravi.call(`/api/projects/${P}/releases`, post({ title: "v2.4" }))).status, 403, "releases are for leads");
    const rel = await asha.call(`/api/projects/${P}/releases`, post({ title: "v2.4", dueAt: Date.now() + 10 * 86400_000 }));
    assert.equal(rel.status, 200, JSON.stringify(rel.body));
    assert.equal((await ravi.call(`/api/items/${item.id}`, patch({ releaseId: rel.body.release.id }))).status, 200);
    assert.equal((await ravi.call(`/api/steps/${item.steps[0].id}`, patch({ done: true }))).status, 200);
    assert.equal((await other.call(`/api/steps/${item.steps[1].id}`, patch({ done: true }))).status, 404);
    assert.equal((await asha.call(`/api/releases/${rel.body.release.id}`, patch({ title: "v2.4 · Nov 14" }))).status, 200);
    const extra = await ravi.call(`/api/items/${item.id}/steps`, post({ text: "Tests for refund.updated" }));
    assert.equal(extra.status, 200);

    // ── posts: an agent asks, the pack delivers, delegate, agent answers, delivered back ──
    // The agent parks its item while it waits on the answer.
    assert.equal((await agentPost(`/items/${item.id}/status`, { member: "ravi", ...RAVI, status: "waiting" })).status, 200);
    const q = await agentPost("/posts", { member: "ravi", ...RAVI, kind: "question", toMember: "asha", text: "Partial refund: credit note or a negative invoice line?" });
    assert.equal(q.status, 200, JSON.stringify(q.body));
    const qid = q.body.id;
    assert.equal(session("S-ravi-1").state, "waiting", "the asking session waits");
    await ingest("ravi", "Asked Asha about partial refunds.", "summary", RAVI, "Stop");
    assert.equal(session("S-ravi-1").state, "waiting", "Stop with an open question stays waiting");
    assert.equal((db.prepare("SELECT item_id FROM posts WHERE id = ?").get(qid) as any).item_id, item.id, "a question about my work lands on my current item");

    const ASHA = { session: "S-asha-1", source: "claude-code", worktree: "/Users/asha/app", repo_root: "/Users/asha/app" };
    const p1 = await pack("asha", ASHA, "start", [], "SessionStart");
    assert.equal(p1.status, 200);
    assert.match(p1.body.text, /ravi's Codex asked your user/);
    assert.match(p1.body.text, /credit note or a negative invoice line/);
    assert.ok(p1.body.shown.includes(`wq:${qid}`));
    assert.equal(session("S-asha-1").state, "idle", "SessionStart heartbeat registers the session");
    const p2 = await pack("asha", ASHA, "delta", p1.body.shown);
    assert.doesNotMatch(p2.body.text, /credit note/, "delivered once per session");
    assert.equal(session("S-asha-1").state, "working", "a UserPromptSubmit heartbeat marks the session working");

    assert.equal((await ravi.call(`/api/posts/${qid}/delegate`, post({}))).status, 403, "only the person asked delegates");
    assert.equal((await other.call(`/api/posts/${qid}/delegate`, post({}))).status, 404);
    assert.equal((await asha.call(`/api/posts/${qid}/delegate`, post({}))).status, 200);
    const p3 = await pack("asha", ASHA, "delta", [...p1.body.shown, ...p2.body.shown]);
    assert.match(p3.body.text, /reins_answer/);
    assert.match(p3.body.text, new RegExp(`questionId ${qid}`));
    // A delegated ask is the user's own request: its own block, never framed as background, never cut.
    assert.match(p3.body.text, /^Your user asked you to handle this from the Reins board/);
    assert.match(p3.body.text, /say you don't know rather than guess\. Then carry on with your user's request\./);

    const ans = await agentPost("/posts", { member: "asha", ...ASHA, kind: "answer", replyTo: qid, text: "Credit note — invoice-export.ts reads credit notes." });
    assert.equal(ans.status, 200, JSON.stringify(ans.body));
    assert.equal((db.prepare("SELECT status FROM posts WHERE id = ?").get(qid) as any).status, "answered");
    assert.equal(session("S-ravi-1").state, "idle", "the answer releases the waiting session");
    assert.equal((db.prepare("SELECT status FROM goals WHERE id = ?").get(item.id) as any).status, "doing", "…and puts its item back in progress");
    assert.equal((await agentPost("/posts", { member: "asha", kind: "answer", replyTo: qid, text: "again" })).status, 409);
    const r1 = await pack("ravi", RAVI, "delta", []);
    assert.match(r1.body.text, /asha's Claude Code answered your question/);
    assert.match(r1.body.text, /Credit note/);
    assert.match(r1.body.text, /Your current item: "Refunds" \(feature, 1\/4 steps\)/);
    const r2 = await pack("ravi", RAVI, "delta", r1.body.shown);
    assert.doesNotMatch(r2.body.text, /answered your question|Your current item/, "each delivered once per session");

    // ── a question to the leads, answered from the web; a decision resolved ──
    const lq = await agentPost("/posts", { member: "ravi", ...RAVI, kind: "decision", text: "Ship refunds behind a flag?" });
    assert.equal(lq.status, 200);
    assert.equal((await ravi.call(`/api/posts/${lq.body.id}/resolve`, post({ status: "approved" }))).status, 200, "the asker may settle their own decision");
    const lq2 = await agentPost("/posts", { member: "ravi", ...RAVI, kind: "question", text: "Which staging DB should I use?" });
    const todayLead = await asha.call(`/api/projects/${P}/today?since=${since}`);
    assert.ok(todayLead.body.needs.some((n: any) => n.postId === lq2.body.id && n.type === "question"), "leads see questions to the leads");
    assert.equal((await asha.call(`/api/posts/${lq2.body.id}/answer`, post({ text: "Use staging-2." }))).status, 200);

    // ── agent API: handover, items, steps, status (blocked) ──
    const ho = await agentPost(`/items/${item.id}/handover`, { member: "ravi", ...RAVI, toMember: "asha", note: "Ledger writes go through ledger.ts." });
    assert.equal(ho.status, 200, JSON.stringify(ho.body));
    assert.equal((db.prepare("SELECT member FROM goals WHERE id = ?").get(item.id) as any).member, "asha");
    const p4 = await pack("asha", ASHA, "delta", [...p1.body.shown, ...p2.body.shown, ...p3.body.shown]);
    assert.match(p4.body.text, /ravi's Codex handed you "Refunds": Ledger writes go through ledger\.ts\./);

    const bug = await agentPost("/items", { member: "asha", ...ASHA, title: "Webcam drops", kind: "bug", steps: ["Reproduce"] });
    assert.equal(bug.status, 200, JSON.stringify(bug.body));
    assert.equal(bug.body.item.title, "Webcam drops");
    assert.equal(bug.body.item.steps[0].text, "Reproduce");
    assert.equal(session("S-asha-1").item_id, bug.body.item.id, "the creating session is attached");
    const st = await agentPost("/steps", { member: "asha", ...ASHA, itemId: bug.body.item.id, text: "Retry the stream" });
    assert.equal(st.status, 200);
    assert.ok(st.body.step.id);
    assert.equal((await agentPost(`/steps/${bug.body.item.steps[0].id}/done`, { member: "asha", ...ASHA })).status, 200);
    const stepRow = db.prepare("SELECT done, done_by, done_source FROM goal_items WHERE id = ?").get(bug.body.item.steps[0].id) as any;
    assert.deepEqual([stepRow.done, stepRow.done_by, stepRow.done_source], [1, "asha", "claude-code"]);
    // No session id: the member's latest session in that worktree is used.
    const blocked = await agentPost(`/items/${bug.body.item.id}/status`, { member: "asha", source: "claude-code", worktree: "/Users/asha/app", status: "blocked", note: "Staging is down since 10:40." });
    assert.equal(blocked.status, 200, JSON.stringify(blocked.body));
    assert.equal(session("S-asha-1").state, "blocked");
    assert.equal((db.prepare("SELECT summary FROM goals WHERE id = ?").get(bug.body.item.id) as any).summary, "Staging is down since 10:40.");
    assert.equal((await agentPost("/sessions/nope/attach", { member: "asha", itemId: bug.body.item.id })).status, 404);
    assert.equal((await agentPost("/sessions/S-ravi-1/attach", { member: "asha", itemId: bug.body.item.id })).status, 403, "not your session");
    assert.equal((await agentPost("/sessions/S-ravi-1/attach", { member: "ravi", itemId: item.id })).status, 200);

    // ── agent API auth + workspace isolation ──
    assert.equal((await other.call("/api/agent/items", post({ project: P, member: "x", title: "t", kind: "bug" }))).status, 401, "no token");
    assert.equal((await agentPost("/items", { member: "x", title: "t", kind: "bug" }, B.tokens.ingest)).status, 403, "another workspace can't write");
    assert.equal((await asha.call(`/api/agent/context?project=${P}&member=asha`, { key: B.tokens.ingest })).status, 404, "or read");
    assert.equal((await agentPost(`/steps/${item.steps[1].id}/done`, { member: "x" }, B.tokens.ingest)).status, 403);
    const ctx = await asha.call(`/api/agent/context?project=${P}&member=asha&session=S-asha-1`, { key });
    assert.equal(ctx.status, 200, JSON.stringify(ctx.body));
    assert.equal(ctx.body.me.member, "asha");
    assert.equal(ctx.body.current.id, bug.body.item.id);
    assert.ok(ctx.body.myItems.some((i: any) => i.id === item.id && i.steps.length === 4));
    assert.ok(ctx.body.teammates.some((t: any) => t.who.member === "ravi" && t.sessions.length >= 1));
    assert.equal(ctx.body.release.title, "v2.4 · Nov 14");

    // ── views: today / me / week / item / people, counted from the events above ──
    const today = await asha.call(`/api/projects/${P}/today?since=${since}`);
    assert.equal(today.status, 200, JSON.stringify(today.body));
    const T = today.body;
    for (const k of ["now", "project", "viewer", "counts", "since", "release", "groups", "untracked", "tracks", "needs", "tape", "people"]) assert.ok(k in T, `today.${k}`);
    assert.deepEqual(T.viewer, { member: "asha", displayName: "asha", role: "owner" });
    assert.deepEqual({ ...T.counts, waitingOnViewer: undefined }, { feature: 1, bug: 1, try: 0, chore: 0, waitingOnViewer: undefined });
    assert.equal(T.since.questionsSettled, 3);
    assert.equal(T.since.blocked, 1);
    assert.equal(T.release.title, "v2.4 · Nov 14");
    assert.deepEqual(T.groups.map((g: any) => g.kind), ["feature", "bug", "try_chore"]);
    const lane = T.groups[0].items[0];
    assert.deepEqual([lane.title, lane.kind, lane.owner.member, lane.release.title, lane.steps.done, lane.steps.total], ["Refunds", "feature", "asha", "v2.4 · Nov 14", 1, 4]);
    assert.ok(lane.agents.some((a: any) => a.sessionId === "S-ravi-1" && a.source === "codex" && a.at === 0.25));
    assert.equal(T.groups[1].items[0].state.tone, "block");
    const row = T.tracks.rows.find((r: any) => r.sessionId === "S-ravi-1");
    assert.ok(row, "the session has a track");
    assert.equal(row.branch, "feat/refund");
    assert.equal(row.worktree, "wt-refunds");
    assert.ok(row.clips.some((c: any) => c.kind === "wait"), "its waiting time is a clip");
    assert.ok(row.clips.some((c: any) => c.kind === "none" || c.kind === "feature"));
    assert.ok(T.needs.some((n: any) => n.type === "blocked" && n.sessionId === "S-asha-1" && n.item.id === bug.body.item.id));
    const tapeKinds = new Set(T.tape.map((e: any) => e.kind));
    for (const k of ["Asked", "Answered", "Delegated", "Handed over", "Blocked", "Decision", "Approved"]) assert.ok(tapeKinds.has(k), `tape has ${k}`);
    assert.ok(T.people.some((p: any) => p.who.member === "asha" && p.owns.feature === 1 && p.owns.bug === 1));

    const me = await ravi.call(`/api/projects/${P}/me?since=${since}`);
    assert.equal(me.status, 200, JSON.stringify(me.body));
    assert.equal(me.body.me.member, "ravi");
    assert.ok(me.body.forYou.some((p: any) => p.kind === "answer" && p.replyTo === qid && p.author.member === "asha" && p.toMember === "ravi"));
    const ag = me.body.agents.find((a: any) => a.sessionId === "S-ravi-1");
    assert.equal(ag.item.id, item.id);
    assert.equal(ag.lastLine, "Asked Asha about partial refunds.");
    assert.ok(["edit", "ask", "test", "test_fail"].every((k) => ag.steps.some((x: any) => x.kind === k)), "edits, asks and test runs are marks");
    assert.ok(Array.isArray(me.body.around) && Array.isArray(me.body.owned) && Array.isArray(me.body.traits));

    const week = await asha.call(`/api/projects/${P}/week?days=7`);
    assert.equal(week.status, 200, JSON.stringify(week.body));
    for (const k of ["from", "to", "tasksDone", "mix", "owned", "people", "table", "look"]) assert.ok(k in week.body, `week.${k}`);
    const wo = week.body.owned.find((o: any) => o.id === item.id);
    assert.deepEqual([wo.before, wo.now, wo.total, wo.perDay.length, wo.perDay.reduce((a: number, b: number) => a + b, 0)], [0, 1, 4, 7, 1]);
    const wp = week.body.people.find((p: any) => p.who.member === "ravi");
    assert.ok(wp.agents >= 1 && wp.days.length === 7);
    assert.ok(week.body.table.some((t: any) => t.who.member === "asha" && t.helped === 1 && t.owns === "1 feature, 1 bug"));

    const iv = await ravi.call(`/api/projects/${P}/items/${item.id}`);
    assert.equal(iv.status, 200, JSON.stringify(iv.body));
    assert.equal(iv.body.item.steps[0].doneBy.member, "ravi");
    assert.equal(iv.body.item.steps[0].doneSource, "web");
    assert.equal(iv.body.item.release.title, "v2.4 · Nov 14");
    assert.ok(["question", "answer", "handover"].every((k) => iv.body.thread.some((p: any) => p.kind === k)));
    assert.deepEqual(iv.body.files, ["billing/ledger.ts"]);
    assert.ok(iv.body.agents.some((a: any) => a.sessionId === "S-ravi-1" && a.who.member === "ravi"));

    const pr = await asha.call(`/api/projects/${P}/people/ravi`);
    assert.equal(pr.status, 200, JSON.stringify(pr.body));
    assert.equal(pr.body.stats.asked, 3);
    assert.equal(typeof pr.body.stats.askMedianMin, "number");
    assert.equal(pr.body.stats.stepsTicked, 1);
    assert.equal(pr.body.week.length, 7);
    const pa = await asha.call(`/api/projects/${P}/people/asha`);
    assert.equal(pa.body.stats.helped, 1);
    assert.equal(pa.body.owns, "1 feature, 1 bug");
    assert.equal((await asha.call(`/api/projects/${P}/people/nobody`)).status, 404);

    // ── unblocking from the board: the item is back in progress and leaves "Needs you" ──
    assert.equal((await asha.call(`/api/items/${bug.body.item.id}`, patch({ status: "doing" }))).status, 200);
    assert.equal(session("S-asha-1").state, "idle", "the blocked session waits for its next prompt");
    const unblocked = (await asha.call(`/api/projects/${P}/today?since=${since}`)).body;
    assert.ok(!unblocked.needs.some((n: any) => n.type === "blocked"), "nothing blocked is left in Needs you");

    // ── finishing work and tracking untracked work ──
    assert.equal((await asha.call(`/api/items/${item.id}`, patch({ status: "done" }))).status, 200);
    const today2 = await asha.call(`/api/projects/${P}/today?since=${since}`);
    assert.equal(today2.body.since.tasksDone, 1);
    assert.ok(today2.body.tape.some((e: any) => e.kind === "Done" && /Refunds/.test(e.text)));
    const NEW = { session: "S-asha-2", source: "claude-code", worktree: "/Users/asha/app" };
    await ingest("asha", "Update the onboarding docs", "intent", NEW, "UserPromptSubmit");
    assert.equal((await other.call("/api/sessions/S-asha-2/track", post({ kind: "chore" }))).status, 404);
    assert.equal((await ravi.call("/api/sessions/S-asha-2/track", post({ kind: "chore" }))).status, 403);
    const tracked = await asha.call("/api/sessions/S-asha-2/track", post({ kind: "chore", title: "Onboarding docs" }));
    assert.equal(tracked.status, 200, JSON.stringify(tracked.body));
    assert.equal(session("S-asha-2").item_id, tracked.body.item.id);

    // ── SessionEnd, and idle on read ──
    await ingest("asha", "SessionEnd event", "progress", NEW, "SessionEnd");
    assert.equal(session("S-asha-2").state, "ended");
    await pack("ravi", { session: "S-ravi-2", source: "opencode", worktree: "/Users/ravi/app" }, "start");
    assert.equal(session("S-ravi-2").state, "working");
    await sleep(IDLE_MS + 400);
    const me2 = await ravi.call(`/api/projects/${P}/me?since=${since}`);
    assert.equal(me2.body.agents.find((a: any) => a.sessionId === "S-ravi-2").state, "idle", "no events for the idle window reads as idle");
    const rows = db.prepare("SELECT state FROM session_states WHERE session_id = 'S-ravi-1' ORDER BY at, rowid").all().map((r: any) => r.state);
    assert.ok(rows.includes("working") && rows.includes("waiting") && rows.includes("idle"), `state log: ${rows.join(",")}`);

    // ── restarting an agent in the same worktree is one agent, not a new row each time ──
    await ingest("ravi", "Pick the refund webhook back up", "intent", { ...RAVI, session: "S-ravi-3" }, "UserPromptSubmit");
    const today3 = (await asha.call(`/api/projects/${P}/today?since=${since}`)).body;
    const raviRows = today3.tracks.rows.filter((r: any) => r.who.member === "ravi" && r.source === "codex" && r.worktree === "wt-refunds");
    assert.equal(raviRows.length, 1, "S-ravi-1 and S-ravi-3 share one track row");
    assert.equal(raviRows[0].sessionId, "S-ravi-3", "the row shows the newest session");
    assert.ok(raviRows[0].clips.some((c: any) => c.kind === "wait"), "…and keeps the earlier session's clips");
    const me3 = (await ravi.call(`/api/projects/${P}/me?since=${since}`)).body;
    assert.equal(me3.agents.filter((a: any) => a.source === "codex" && a.worktree === "wt-refunds").length, 1, "My day merges them too");
  } finally {
    child.kill("SIGTERM");
    llm.server.close();
  }
});
