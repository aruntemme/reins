import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import readline from "node:readline";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, "..", "bin.mjs");
const SERVER_INDEX = resolve(HERE, "..", "..", "server", "src", "index.ts");
const SERVER_DIR = resolve(HERE, "..", "..", "server");

function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once("error", rej);
    srv.listen(0, () => { const p = srv.address().port; srv.close(() => res(p)); });
  });
}

async function waitHealth(url, child, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})`);
    try { if ((await fetch(`${url}/health`)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("server never became healthy");
}

// Minimal MCP stdio client: line-delimited JSON-RPC, match responses by id.
function mcpClient(child) {
  const pending = new Map();
  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    const s = line.trim();
    if (!s) return;
    let msg; try { msg = JSON.parse(s); } catch { return; }
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  let seq = 0;
  const req = (method, params) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, res);
    const t = setTimeout(() => { pending.delete(id); rej(new Error(`timeout ${method}`)); }, 10000);
    pending.set(id, (m) => { clearTimeout(t); res(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  const call = async (name, args) => {
    const r = await req("tools/call", { name, arguments: args || {} });
    return r.result;
  };
  return { req, notify, call };
}

test("HTTP MCP: handshake, list, and read/write tools over the real API", async () => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), REINS_DB: join(tmpdir(), `reins-mcp-${randomUUID()}.db`), REINS_AUTH: "on", REINS_SESSION_SECRET: "mcp-test", REINS_LLM_API_KEY: "" };
  const server = spawn(process.execPath, ["--import", "tsx", SERVER_INDEX], { cwd: SERVER_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
  server.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

  let mcp;
  try {
    await waitHealth(url, server);

    // Seed: owner account (gives an access + ingest token), a project, a member, a goal.
    const signup = await (await fetch(`${url}/api/auth/signup`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `o-${randomUUID().slice(0, 6)}@x.test`, password: "supersecret-1", workspaceName: "Acme" }),
    })).json();
    const access = signup.tokens.access;
    const ingest = signup.tokens.ingest;
    assert.ok(access && ingest, "signup returned tokens");

    const authed = (path, body, headers = {}) => fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${access}`, ...headers }, body: JSON.stringify(body) });
    assert.equal((await authed("/api/projects", { id: "demo", name: "Demo" })).status, 200);
    // A member with activity (degraded distill is fine — no LLM needed here).
    await fetch(`${url}/api/ingest`, { method: "POST", headers: { "content-type": "application/json", "x-reins-key": ingest }, body: JSON.stringify({ project: "demo", member: "asha", text: "working on auth", kind: "progress" }) });
    assert.equal((await authed("/api/projects/demo/goals", { scope: "individual", member: "asha", title: "ship auth" })).status, 200);

    // Launch the MCP pointed at the server, with both tokens.
    const child = spawn(process.execPath, [BIN, "mcp", "--url", url, "--token", access, "--ingest-token", ingest], { stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.on("data", (d) => process.stderr.write(`[mcp] ${d}`));
    mcp = mcpClient(child);

    // 1) handshake
    const init = await mcp.req("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    assert.equal(init.result.serverInfo.name, "reins", "initialize returns serverInfo");
    assert.ok(init.result.capabilities.tools, "advertises tools capability");
    mcp.notify("notifications/initialized", {});

    // 2) tools/list
    const list = await mcp.req("tools/list", {});
    const names = list.result.tools.map((t) => t.name);
    for (const t of ["reins_context", "reins_projects", "reins_member", "reins_goals", "reins_profile", "reins_goal_add", "reins_note"]) {
      assert.ok(names.includes(t), `tools/list includes ${t}`);
    }

    // 3) read tools hit the real API
    const projects = await mcp.call("reins_projects", {});
    assert.match(projects.content[0].text, /demo/, "reins_projects shows the project");

    const ctx = await mcp.call("reins_context", { project: "demo" });
    assert.match(ctx.content[0].text, /asha/, "reins_context shows the member");

    const goals = await mcp.call("reins_goals", { project: "demo" });
    assert.match(goals.content[0].text, /ship auth/, "reins_goals shows the seeded goal");

    // 4) write tool round-trips through the API
    const add = await mcp.call("reins_goal_add", { project: "demo", member: "asha", title: "new goal via mcp" });
    assert.equal(add.isError, false, "reins_goal_add succeeded");
    const goals2 = await mcp.call("reins_goals", { project: "demo" });
    assert.match(goals2.content[0].text, /new goal via mcp/, "the goal the MCP created is now visible");

    // 5) note posting works with the ingest token
    const note = await mcp.call("reins_note", { project: "demo", member: "asha", text: "did a thing via mcp", kind: "progress" });
    assert.equal(note.isError, false, "reins_note posted with the ingest token");

    // 6) a bad call returns a tool error, not a crash
    const bad = await mcp.call("reins_member", { project: "demo", member: "nobody-here" });
    assert.equal(bad.isError, true, "unknown member surfaces as a tool error");

    child.kill("SIGKILL");
  } finally {
    server.kill("SIGKILL");
  }
});
