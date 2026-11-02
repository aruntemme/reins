import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

// Real server, real SQLite, real HTTP: the reins-hook device login end to end
// (terminal starts a login and polls, a signed-in human approves in the browser,
// the token works on the hook's hello), plus every refusal path.
const SECRET = "test-secret-cli-login-0123456789ab";

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once("error", rej);
    srv.listen(0, () => {
      const a = srv.address();
      const port = typeof a === "object" && a ? a.port : 0;
      srv.close(() => res(port));
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

async function startServer(extraEnv: Record<string, string>) {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--import", "tsx", resolve(import.meta.dirname, "..", "index.ts")], {
    env: {
      ...process.env,
      PORT: String(port),
      REINS_DB: join(tmpdir(), `reins-cli-login-${randomUUID()}.db`),
      REINS_SESSION_SECRET: SECRET,
      REINS_TRUST_PROXY: "1",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (d) => process.stderr.write(`[server] ${d}`));
  await waitForHealth(url, child);
  return { url, child };
}

function makeClient(base: string, ip: string) {
  let cookie = "";
  return {
    async call(path: string, init: RequestInit & { key?: string } = {}) {
      const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": ip };
      if (init.key) headers["x-reins-key"] = init.key;
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const POLL_GAP = 1100; // the server answers slow_down to polls under ~1s apart

type Client = ReturnType<typeof makeClient>;
async function signup(c: Client, email: string, workspaceName?: string) {
  const r = await c.call("/api/auth/signup", post({ email, password: "supersecret-1", workspaceName }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body as { workspace: { id: string; name: string }; tokens: { ingest: string } };
}

const CODE = /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/;

test("cli device login: approve, single pickup, hello, and refusals", async () => {
  const { url, child } = await startServer({ REINS_AUTH: "on" });
  try {
    const uid = randomUUID().slice(0, 8);
    const ownerEmail = `asha-${uid}@acme.test`;
    const owner = makeClient(url, "10.4.0.1");
    const A = await signup(owner, ownerEmail, "Acme");
    const other = makeClient(url, "10.4.0.2");
    await signup(other, `b-${uid}@beta.test`, "Beta");
    const terminal = makeClient(url, "10.4.0.9"); // never signed in

    const P = `demo-${uid}`;
    assert.equal((await owner.call("/api/projects", post({ id: P, name: "Demo" }))).status, 200);
    const Q = `beta-app`;
    assert.equal((await other.call("/api/projects", post({ id: Q, name: "Beta App" }))).status, 200);

    // ── Start: public, returns the secret + the code to show the human.
    const start = await terminal.call("/api/cli/login", post({ host: "asha-mbp", repo: "/home/asha/Checkout-V2" }));
    assert.equal(start.status, 200, JSON.stringify(start.body));
    const { deviceCode, userCode } = start.body;
    assert.match(deviceCode, /^[A-Za-z0-9_-]{43}$/, "32 random bytes, base64url");
    assert.match(userCode, CODE);
    assert.equal(start.body.verifyPath, `/cli?code=${userCode}`);
    assert.equal(start.body.expiresIn, 600);
    assert.equal(start.body.interval, 2);
    assert.deepEqual((await terminal.call("/api/cli/poll", post({ deviceCode }))).body, { status: "pending" });

    // ── The approve page: signed-in only; code is case-insensitive, dash optional.
    assert.equal((await terminal.call(`/api/cli/login/${userCode}`)).status, 401);
    const looseCode = userCode.replace("-", "").toLowerCase();
    const view = await owner.call(`/api/cli/login/${looseCode}`);
    assert.equal(view.status, 200, JSON.stringify(view.body));
    assert.equal(view.body.userCode, userCode);
    assert.equal(view.body.host, "asha-mbp");
    assert.equal(view.body.repo, "/home/asha/Checkout-V2");
    assert.equal(view.body.status, "pending");
    assert.ok(view.body.expiresAt > Date.now());
    assert.deepEqual(view.body.workspace, { id: A.workspace.id, name: "Acme" });
    assert.deepEqual(view.body.projects, [{ id: P, name: "Demo" }], "only the caller's workspace projects");
    assert.equal(view.body.suggestedProject, "checkout-v2");
    assert.equal((await owner.call(`/api/cli/login/ZZZZ-ZZZZ`)).status, 404);
    assert.equal((await owner.call(`/api/cli/login/not-a-code`)).status, 404);
    // A terminal pointed at a project (--project) gets that one preselected, not the repo guess.
    const hinted = await terminal.call("/api/cli/login", post({ host: "asha-mbp", repo: "/home/asha/Checkout-V2", project: P }));
    assert.equal((await owner.call(`/api/cli/login/${hinted.body.userCode}`)).body.suggestedProject, P);

    // ── Approve: bad body, then another workspace's project — 404, no leak, still pending.
    assert.equal((await owner.call(`/api/cli/login/${userCode}/approve`, post({}))).status, 400);
    assert.equal((await owner.call(`/api/cli/login/${userCode}/approve`, post({ project: P, newProject: { name: "x" } }))).status, 400);
    const cross = await owner.call(`/api/cli/login/${userCode}/approve`, post({ project: Q }));
    assert.equal(cross.status, 404);
    assert.deepEqual(cross.body, { error: "project not found" }, "same answer as a project that doesn't exist");
    assert.deepEqual((await owner.call(`/api/cli/login/${userCode}/approve`, post({ project: "nope-nope" }))).body, { error: "project not found" });
    assert.equal((await owner.call(`/api/cli/login/${userCode}`)).body.status, "pending");

    const ok = await owner.call(`/api/cli/login/${userCode}/approve`, post({ project: P }));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body, { ok: true, project: { id: P, name: "Demo" } });
    assert.equal((await owner.call(`/api/cli/login/${userCode}/approve`, post({ project: P }))).status, 409, "approve only once");
    assert.equal((await owner.call(`/api/cli/login/${userCode}/deny`, post({}))).status, 409, "no deny after approve");
    assert.equal((await owner.call(`/api/cli/login/${userCode}`)).body.status, "approved");

    // ── Poll: credentials exactly once, then gone.
    await sleep(POLL_GAP);
    const got = await terminal.call("/api/cli/poll", post({ deviceCode }));
    assert.equal(got.status, 200, JSON.stringify(got.body));
    assert.equal(got.body.status, "approved");
    assert.match(got.body.token, /^rk_ingest_[0-9a-f]{48}$/);
    assert.equal(got.body.member, ownerEmail);
    assert.deepEqual(got.body.project, { id: P, name: "Demo" });
    assert.deepEqual(got.body.workspace, { id: A.workspace.id, name: "Acme" });
    await sleep(POLL_GAP);
    const again = await terminal.call("/api/cli/poll", post({ deviceCode }));
    assert.equal(again.status, 410);
    assert.deepEqual(again.body, { status: "expired" });
    assert.equal((await owner.call(`/api/cli/login/${userCode}`)).body.status, "consumed");
    assert.equal((await terminal.call("/api/cli/poll", post({ deviceCode: "x".repeat(43) }))).status, 410, "unknown reads as expired");

    // The minted token is labelled for the admin's token list.
    const tokens = (await owner.call("/api/admin/tokens")).body.tokens as { label: string; kind: string }[];
    assert.ok(tokens.some((t) => t.kind === "ingest" && t.label === `cli · ${ownerEmail} · asha-mbp`), JSON.stringify(tokens));

    // ── Hello with the picked-up token: the member shows on the board.
    const hello = await terminal.call("/api/hook/hello", { ...post({ project: P, member: ownerEmail, displayName: "Asha", source: "claude-code" }), key: got.body.token });
    assert.equal(hello.status, 200, JSON.stringify(hello.body));
    assert.deepEqual(hello.body, { ok: true, project: { id: P, name: "Demo" } });
    const board = await owner.call(`/api/projects/${P}`);
    assert.equal(board.status, 200);
    const me = board.body.members.find((m: any) => m.member === ownerEmail);
    assert.ok(me, "the hello put the member on the board");
    assert.equal(me.displayName, "Asha");
    const crossHello = await terminal.call("/api/hook/hello", { ...post({ project: Q, member: ownerEmail }), key: got.body.token });
    assert.equal(crossHello.status, 403);
    assert.match(crossHello.body.error, /belongs to another workspace/);
    assert.equal((await terminal.call("/api/hook/hello", post({ project: P, member: ownerEmail }))).status, 401, "no token, no hello");

    // ── Approve with a new project: id = slug of the name, suffixed if taken anywhere.
    const newLogin = async () => (await terminal.call("/api/cli/login", post({ host: "asha-mbp" }))).body as { deviceCode: string; userCode: string };
    const l2 = await newLogin();
    const n2 = await owner.call(`/api/cli/login/${l2.userCode}/approve`, post({ newProject: { name: "Checkout V2" } }));
    assert.deepEqual(n2.body, { ok: true, project: { id: "checkout-v2", name: "Checkout V2" } });
    const l3 = await newLogin();
    const n3 = await owner.call(`/api/cli/login/${l3.userCode}/approve`, post({ newProject: { name: "Checkout V2" } }));
    assert.match(n3.body.project.id, /^checkout-v2-[0-9a-f]{4}$/, "own workspace's id taken → suffix");
    const l4 = await newLogin();
    const n4 = await owner.call(`/api/cli/login/${l4.userCode}/approve`, post({ newProject: { name: "Beta App" } }));
    assert.match(n4.body.project.id, /^beta-app-[0-9a-f]{4}$/, "another workspace's id taken → suffix, never theirs");
    const ownProjects = (await owner.call("/api/projects")).body.projects.map((p: any) => p.id);
    assert.ok(ownProjects.includes("checkout-v2") && ownProjects.includes(n4.body.project.id) && !ownProjects.includes(Q));
    const p2 = await terminal.call("/api/cli/poll", post({ deviceCode: l2.deviceCode }));
    assert.equal(p2.body.status, "approved");
    assert.deepEqual(p2.body.project, { id: "checkout-v2", name: "Checkout V2" });

    // ── Deny.
    const l5 = await newLogin();
    assert.deepEqual((await owner.call(`/api/cli/login/${l5.userCode}/deny`, post({}))).body, { ok: true });
    assert.deepEqual((await terminal.call("/api/cli/poll", post({ deviceCode: l5.deviceCode }))).body, { status: "denied" });
    assert.equal((await owner.call(`/api/cli/login/${l5.userCode}/approve`, post({ project: P }))).status, 409);
    assert.equal((await owner.call(`/api/cli/login/${l5.userCode}`)).body.status, "denied");

    // ── Polling faster than ~1/s.
    const l6 = await newLogin();
    assert.equal((await terminal.call("/api/cli/poll", post({ deviceCode: l6.deviceCode }))).status, 200);
    const fast = await terminal.call("/api/cli/poll", post({ deviceCode: l6.deviceCode }));
    assert.equal(fast.status, 429);
    assert.deepEqual(fast.body, { status: "slow_down" });
    await sleep(POLL_GAP);
    assert.deepEqual((await terminal.call("/api/cli/poll", post({ deviceCode: l6.deviceCode }))).body, { status: "pending" });

    // ── A teammate approves for themselves; removed before pickup → no token.
    const invite = await owner.call(`/api/workspaces/${A.workspace.id}/invites`, post({ role: "member" }));
    const mate = makeClient(url, "10.4.0.3");
    const mateEmail = `ravi-${uid}@acme.test`;
    await signup(mate, mateEmail);
    assert.equal((await mate.call("/api/auth/join", post({ code: invite.body.code }))).status, 200);
    assert.equal((await mate.call("/api/auth/switch", post({ workspaceId: A.workspace.id }))).status, 200);
    const l7 = await newLogin();
    assert.equal((await mate.call(`/api/cli/login/${l7.userCode}/approve`, post({ project: P }))).status, 200);
    const l8 = await newLogin();
    assert.equal((await mate.call(`/api/cli/login/${l8.userCode}/approve`, post({ project: P }))).status, 200);
    const p7 = await terminal.call("/api/cli/poll", post({ deviceCode: l7.deviceCode }));
    assert.equal(p7.body.status, "approved");
    assert.equal(p7.body.member, mateEmail, "the approver's own identity, not the owner's");
    const members = (await owner.call(`/api/workspaces/${A.workspace.id}/members`)).body.members as { userId: string; email: string }[];
    const mateId = members.find((m) => m.email === mateEmail)!.userId;
    assert.equal((await owner.call(`/api/workspaces/${A.workspace.id}/members/${mateId}`, { method: "DELETE" })).status, 200);
    assert.deepEqual((await terminal.call("/api/cli/poll", post({ deviceCode: l8.deviceCode }))).body, { status: "denied" });
  } finally {
    child.kill("SIGKILL");
  }
});

test("cli device login: expiry is enforced on read, approve, deny and poll", async () => {
  // REINS_CLI_LOGIN_TTL_MS shortens the 10-minute window so this runs in seconds.
  const { url, child } = await startServer({ REINS_AUTH: "on", REINS_CLI_LOGIN_TTL_MS: "1500" });
  try {
    const owner = makeClient(url, "10.5.0.1");
    await signup(owner, `lead-${randomUUID().slice(0, 8)}@acme.test`, "Acme");
    assert.equal((await owner.call("/api/projects", post({ id: "exp", name: "Exp" }))).status, 200);
    const terminal = makeClient(url, "10.5.0.9");

    const idle = (await terminal.call("/api/cli/login", post({}))).body;
    assert.equal(idle.expiresIn, 2);
    const approvedLate = (await terminal.call("/api/cli/login", post({}))).body;
    assert.equal((await owner.call(`/api/cli/login/${approvedLate.userCode}/approve`, post({ project: "exp" }))).status, 200);
    await sleep(1700);

    assert.equal((await owner.call(`/api/cli/login/${idle.userCode}`)).body.status, "expired");
    assert.equal((await owner.call(`/api/cli/login/${idle.userCode}/approve`, post({ project: "exp" }))).status, 410);
    assert.equal((await owner.call(`/api/cli/login/${idle.userCode}/deny`, post({}))).status, 410);
    const p = await terminal.call("/api/cli/poll", post({ deviceCode: idle.deviceCode }));
    assert.equal(p.status, 410);
    assert.deepEqual(p.body, { status: "expired" });

    // Approved in time but never picked up: the window still closes.
    assert.equal((await owner.call(`/api/cli/login/${approvedLate.userCode}`)).body.status, "expired");
    const late = await terminal.call("/api/cli/poll", post({ deviceCode: approvedLate.deviceCode }));
    assert.equal(late.status, 410);
    assert.ok(!late.body.token);
  } finally {
    child.kill("SIGKILL");
  }
});

test("cli device login: refused when auth is off; hello still works", async () => {
  const { url, child } = await startServer({ REINS_AUTH: "off" });
  try {
    const c = makeClient(url, "10.6.0.1");
    const r = await c.call("/api/cli/login", post({ host: "box" }));
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { error: "auth is off" });
    const hello = await c.call("/api/hook/hello", post({ project: "open-proj", member: "dev@x.test" }));
    assert.equal(hello.status, 200, JSON.stringify(hello.body));
    assert.deepEqual(hello.body, { ok: true, project: { id: "open-proj", name: "open-proj" } });
    const board = await c.call("/api/projects/open-proj");
    assert.ok(board.body.members.some((m: any) => m.member === "dev@x.test"));
  } finally {
    child.kill("SIGKILL");
  }
});
