import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

// Real server (auth ON), real SQLite, real HTTP. Activity comes from hook
// touches, which never call the LLM, so the brief is deterministic.
const DB_PATH = join(tmpdir(), `reins-member-brief-${randomUUID()}.db`);
const SECRET = "test-secret-member-brief-0123456789";

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

function makeClient(base: string, ip: string) {
  let cookie = "";
  return {
    async call(path: string, init: RequestInit & { bearer?: string; key?: string } = {}) {
      const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": ip };
      if (init.bearer) headers["authorization"] = `Bearer ${init.bearer}`;
      else if (init.key) headers["x-reins-key"] = init.key;
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

test("member brief: the hook's session-start text, tenant-scoped", async () => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--import", "tsx", resolve(import.meta.dirname, "..", "index.ts")], {
    env: { ...process.env, PORT: String(port), REINS_DB: DB_PATH, REINS_AUTH: "on", REINS_SESSION_SECRET: SECRET, REINS_TRUST_PROXY: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (d) => process.stderr.write(`[server] ${d}`));

  try {
    await waitForHealth(url, child);
    const uid = randomUUID().slice(0, 8);
    const signup = async (c: ReturnType<typeof makeClient>, email: string, name: string) => {
      const r = await c.call("/api/auth/signup", post({ email, password: "supersecret-1", workspaceName: name }));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.body as { tokens: { ingest: string; access: string } };
    };
    const owner = makeClient(url, "10.2.0.1");
    const A = await signup(owner, `lead-${uid}@acme.test`, "Acme");
    const other = makeClient(url, "10.2.0.2");
    const B = await signup(other, `b-${uid}@beta.test`, "Beta");

    const P = `brief-${uid}`;
    assert.equal((await owner.call("/api/projects", post({ id: P, name: "Demo" }))).status, 200);
    assert.equal((await owner.call(`/api/projects/${P}/goal`, put({ goal: "Ship OAuth login" }))).status, 200);
    const touch = (member: string, displayName: string, path: string) =>
      owner.call("/api/hook/touch", { ...post({ project: P, member, displayName, path, tool: "Edit" }), key: A.tokens.ingest });
    assert.equal((await touch("asha", "Asha", "src/auth/session.ts")).status, 200);
    assert.equal((await touch("ravi", "Ravi", "src/login/page.tsx")).status, 200);

    const brief = await owner.call(`/api/projects/${P}/members/ravi/brief`);
    assert.equal(brief.status, 200, JSON.stringify(brief.body));
    assert.deepEqual(Object.keys(brief.body).sort(), ["text", "version"]);
    assert.match(brief.body.text, /^Reins team context for "Demo" \(you are Ravi\)/);
    assert.match(brief.body.text, /Project goal: Ship OAuth login/);
    assert.match(brief.body.text, /Asha \[active\] — .* on src\/auth\/session\.ts/);
    assert.ok(brief.body.text.length <= 1200, `capped like the hook (${brief.body.text.length} chars)`);

    // Byte-for-byte what the hook injects at SessionStart.
    const hook = await owner.call("/api/hook/pack", { ...post({ project: P, member: "ravi", mode: "start" }), key: A.tokens.ingest });
    assert.equal(hook.status, 200);
    assert.equal(brief.body.text, hook.body.text);
    assert.equal(brief.body.version, hook.body.version);

    // An access token (agents over the HTTP MCP) reads it too.
    assert.equal((await owner.call(`/api/projects/${P}/members/ravi/brief`, { bearer: A.tokens.access })).status, 200);

    // Unknown member, no credentials, and another workspace are all refused.
    assert.equal((await owner.call(`/api/projects/${P}/members/nobody/brief`)).status, 404);
    assert.equal((await makeClient(url, "10.2.0.3").call(`/api/projects/${P}/members/ravi/brief`)).status, 401);
    const cross = await other.call(`/api/projects/${P}/members/ravi/brief`);
    assert.equal(cross.status, 404, "another workspace learns nothing, not even that it exists");
    assert.ok(!cross.body?.text);
    assert.equal((await other.call(`/api/projects/${P}/members/ravi/brief`, { bearer: B.tokens.access })).status, 404);
  } finally {
    child.kill("SIGKILL");
  }
});
