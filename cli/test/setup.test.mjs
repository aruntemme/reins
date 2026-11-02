import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, statSync, realpathSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "bin.mjs");
const TOKEN = "rk_ingest_wizard";

/**
 * A minimal real server speaking the contract's endpoints (health, device login,
 * poll, hello, projects). It tests the CLI client, so it only needs to answer the
 * way the Reins server does; `pollScript` drives what each poll returns.
 */
async function contractServer({ auth = true, pollScript = ["pending", "slow_down", "approved"], projects = [] } = {}) {
  const calls = [];
  const script = [...pollScript];
  let logins = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ method: req.method, path: req.url, body, key: req.headers["x-reins-key"] });
      const send = (status, json) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(json)); };
      if (req.method === "GET" && req.url === "/health") return send(200, { ok: true, llm: true, model: "test-model", auth });
      if (req.method === "POST" && req.url === "/api/cli/login") {
        if (!auth) return send(400, { error: "auth is off" });
        logins++;
        return send(200, { deviceCode: `dev-${logins}`, userCode: "ABCD-EFGH", verifyPath: "/cli?code=ABCD-EFGH", expiresIn: 30, interval: 0.05 });
      }
      if (req.method === "POST" && req.url === "/api/cli/poll") {
        if (body.deviceCode !== `dev-${logins}`) return send(410, { status: "expired" });
        const next = script.shift() || "expired";
        if (next === "slow_down") return send(429, { status: "slow_down" });
        if (next === "expired") return send(410, { status: "expired" });
        if (next === "approved") {
          return send(200, { status: "approved", token: TOKEN, member: "asha@acme.test", project: { id: "demo", name: "Demo" }, workspace: { id: "w1", name: "acme" } });
        }
        return send(200, { status: next });
      }
      if (req.method === "POST" && req.url === "/api/hook/hello") {
        if (auth && req.headers["x-reins-key"] !== TOKEN) return send(401, { error: "invalid token" });
        return send(200, { ok: true, project: { id: body.project, name: body.project === "demo" ? "Demo" : body.project } });
      }
      if (req.method === "GET" && req.url === "/api/projects") return send(200, projects);
      send(404, { error: "not found" });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close() };
}

function gitRepo() {
  const dir = mkdtempSync(join(tmpdir(), "reins-wiz-repo-"));
  const g = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "asha@acme.test");
  g("config", "user.name", "Asha");
  return realpathSync(dir);
}

function cleanEnv(home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" };
  for (const k of Object.keys(env)) if (k.startsWith("REINS_")) delete env[k];
  delete env.CODEX_HOME;
  delete env.XDG_CONFIG_HOME;
  env.REINS_STATE_DIR = join(home, ".reins", "state");
  return env;
}

/** Run the CLI without a TTY (async: the test server lives in this process). */
function cli(args, { cwd, home }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd, env: cleanEnv(home), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

const json = (p) => JSON.parse(readFileSync(p, "utf8"));

test("headless setup: device login → every agent's real config → config.json → hello per agent → summary", async () => {
  const srv = await contractServer();
  const home = mkdtempSync(join(tmpdir(), "reins-wiz-home-"));
  const repo = gitRepo();
  try {
    const r = await cli(["--url", srv.url, "--project", "demo", "--agents", "claude-code,codex,opencode,aider", "--yes", "--no-open"], { cwd: repo, home });
    assert.equal(r.code, 0, r.out);
    // The code and the approval link are printed for the person to check in the browser.
    assert.match(r.out, /A B C D - E F G H/);
    assert.ok(r.out.includes(`${srv.url}/cli?code=ABCD-EFGH`));
    assert.ok(r.out.includes(`Open the board: ${srv.url}/project/demo`));
    assert.match(r.out, /Claude Code: run \/hooks to approve/);

    const login = srv.calls.find((c) => c.path === "/api/cli/login");
    assert.deepEqual(login.body, { host: hostname().slice(0, 120), repo: basename(repo), project: "demo" });
    const polls = srv.calls.filter((c) => c.path === "/api/cli/poll");
    assert.equal(polls.length, 3, "pending, slow_down, approved");

    const cfgPath = join(home, ".reins", "config.json");
    const cfg = json(cfgPath);
    assert.deepEqual(cfg.servers[srv.url], { token: TOKEN, member: "asha@acme.test", workspace: { id: "w1", name: "acme" } });
    assert.deepEqual(cfg.repos[repo], { url: srv.url, project: "demo" });
    if (process.platform !== "win32") assert.equal(statSync(cfgPath).mode & 0o777, 0o600);

    // No secret lands in any agent config.
    const local = readFileSync(join(repo, ".claude", "settings.local.json"), "utf8");
    assert.match(local, /REINS_SOURCE=claude-code node/);
    for (const f of [join(repo, ".claude", "settings.local.json"), join(home, ".codex", "config.toml"),
      join(home, ".config", "opencode", "plugins", "reins.js"), join(home, ".aider.conf.yml")]) {
      assert.ok(existsSync(f), `${f} written`);
      assert.ok(!readFileSync(f, "utf8").includes(TOKEN), `${f} holds no token`);
    }

    const hellos = srv.calls.filter((c) => c.path === "/api/hook/hello");
    assert.deepEqual(hellos.map((h) => h.body.source).sort(), ["aider", "claude-code", "codex", "opencode"]);
    for (const h of hellos) {
      assert.equal(h.key, TOKEN);
      assert.deepEqual([h.body.project, h.body.member, h.body.displayName], ["demo", "asha@acme.test", "Asha"]);
    }

    // Second run: the saved sign-in still works, so no new login; configs update in place.
    const before = srv.calls.length;
    const again = await cli(["--url", srv.url, "--agents", "claude-code,codex", "--yes", "--no-open"], { cwd: repo, home });
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /Already signed in as asha@acme\.test/);
    assert.ok(!srv.calls.slice(before).some((c) => c.path === "/api/cli/login"), "reused the saved credential");
    assert.equal(readFileSync(join(home, ".codex", "config.toml"), "utf8").match(/^notify = /gm).length, 1);
    const settings = json(join(repo, ".claude", "settings.local.json"));
    assert.equal(settings.hooks.Stop.length, 1, "no duplicate Claude hook");

    // status reports it all back.
    const st = await cli(["status"], { cwd: repo, home });
    assert.match(st.out, /asha@acme\.test/);
    assert.match(st.out, /project demo/);
    assert.match(st.out, /✓ Codex CLI/);
    assert.match(st.out, /✓ Claude Code/);
  } finally {
    srv.close();
  }
});

test("headless setup: a denied sign-in fails with a clear message and writes nothing", async () => {
  const srv = await contractServer({ pollScript: ["pending", "denied"] });
  const home = mkdtempSync(join(tmpdir(), "reins-wiz-home-"));
  const repo = gitRepo();
  try {
    const r = await cli(["--url", srv.url, "--agents", "claude-code", "--yes", "--no-open"], { cwd: repo, home });
    assert.equal(r.code, 1);
    assert.match(r.out, /denied in the browser/);
    assert.ok(!existsSync(join(home, ".reins", "config.json")));
    assert.ok(!existsSync(join(repo, ".claude", "settings.local.json")));
  } finally {
    srv.close();
  }
});

test("headless setup: an expired code is reported", async () => {
  const srv = await contractServer({ pollScript: ["pending", "expired"] });
  const home = mkdtempSync(join(tmpdir(), "reins-wiz-home-"));
  try {
    const r = await cli(["--url", srv.url, "--agents", "codex", "--yes", "--no-open"], { cwd: gitRepo(), home });
    assert.equal(r.code, 1);
    assert.match(r.out, /expired/);
  } finally {
    srv.close();
  }
});

test("headless setup on a server without accounts: no login, project from /api/projects, git email as member", async () => {
  const srv = await contractServer({ auth: false, projects: [{ id: "shop", name: "Shop" }] });
  const home = mkdtempSync(join(tmpdir(), "reins-wiz-home-"));
  const repo = gitRepo();
  try {
    const r = await cli(["setup", "--url", srv.url, "--project", "shop", "--agents", "aider", "--yes", "--no-open"], { cwd: repo, home });
    assert.equal(r.code, 0, r.out);
    assert.ok(!srv.calls.some((c) => c.path === "/api/cli/poll"));
    assert.deepEqual(json(join(home, ".reins", "config.json")).repos[repo], { url: srv.url, project: "shop" });
    const hello = srv.calls.find((c) => c.path === "/api/hook/hello");
    assert.deepEqual([hello.body.project, hello.body.member, hello.body.source], ["shop", "asha@acme.test", "aider"]);
    assert.match(r.out, /Project Shop \(shop\)/);
  } finally {
    srv.close();
  }
});

test("setup without a terminal and without --yes points to the flag-based install", async () => {
  const home = mkdtempSync(join(tmpdir(), "reins-wiz-home-"));
  const r = await cli([], { cwd: gitRepo(), home });
  assert.equal(r.code, 1);
  assert.match(r.out, /needs a terminal/);
  assert.match(r.out, /npx reins-hook install --agent/);
});

test("headless setup: an unreachable server fails fast with a friendly error", async () => {
  const home = mkdtempSync(join(tmpdir(), "reins-wiz-home-"));
  const r = await cli(["--url", "http://127.0.0.1:9", "--yes", "--no-open"], { cwd: gitRepo(), home });
  assert.equal(r.code, 1);
  assert.match(r.out, /http:\/\/127\.0\.0\.1:9 — couldn't reach it/);
});
