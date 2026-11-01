import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, statSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig, rememberSetup, forgetSetup, resolveRuntime, repoEntry } from "../lib/config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..");

// gitRoot caches under the state dir; keep it out of the real ~/.reins.
process.env.REINS_STATE_DIR = mkdtempSync(join(tmpdir(), "reins-state-"));

function gitRepo(email = "dev@acme.test") {
  const dir = mkdtempSync(join(tmpdir(), "reins-repo-"));
  const g = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", email);
  mkdirSync(join(dir, "src"));
  return realpathSync(dir);
}

test("saveConfig writes mode 0600 and loadConfig round-trips; a corrupt file reads as empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "reins-cfg-"));
  const path = join(dir, ".reins", "config.json");
  assert.deepEqual(loadConfig(path), { version: 1, servers: {}, repos: {} });
  saveConfig({ servers: { "https://r.dev": { token: "rk_1" } }, repos: {} }, path);
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(loadConfig(path).servers["https://r.dev"].token, "rk_1");
  writeFileSync(path, "{ not json");
  assert.deepEqual(loadConfig(path), { version: 1, servers: {}, repos: {} });
});

test("rememberSetup merges per field and normalises the URL; forgetSetup drops a repo or everything", () => {
  const path = join(mkdtempSync(join(tmpdir(), "reins-cfg-")), "config.json");
  rememberSetup({ server: { url: "https://r.dev/", token: "rk_1", member: "asha@acme.dev", workspace: { id: "w", name: "acme" } } }, path);
  rememberSetup({ server: { url: "https://r.dev", member: undefined }, repo: { root: "/src/app", url: "https://r.dev/", project: "app" } }, path);
  let cfg = loadConfig(path);
  assert.deepEqual(cfg.servers["https://r.dev"], { token: "rk_1", member: "asha@acme.dev", workspace: { id: "w", name: "acme" } });
  assert.deepEqual(cfg.repos["/src/app"], { url: "https://r.dev", project: "app" });
  forgetSetup({ root: "/src/app" }, path);
  cfg = loadConfig(path);
  assert.deepEqual(cfg.repos, {});
  assert.ok(cfg.servers["https://r.dev"], "credentials survive a repo forget");
  forgetSetup({ credentials: true }, path);
  assert.deepEqual(loadConfig(path).servers, {});
});

test("resolveRuntime: explicit env wins, field by field, over the repo map", () => {
  const repo = gitRepo();
  const config = {
    servers: { "https://r.dev": { token: "rk_cfg", member: "cfg@acme.dev" }, "https://other.dev": { token: "rk_other", member: "o@acme.dev" } },
    repos: { [repo]: { url: "https://r.dev", project: "mapped" } },
  };
  const rt = resolveRuntime({ cwd: join(repo, "src"), env: { REINS_PROJECT: "from-env", REINS_SOURCE: "codex" }, config });
  assert.deepEqual([rt.url, rt.project, rt.key, rt.member, rt.source], ["https://r.dev", "from-env", "rk_cfg", "cfg@acme.dev", "codex"]);
  // An env URL selects that server's credential.
  const rt2 = resolveRuntime({ cwd: repo, env: { REINS_URL: "https://other.dev/" }, config });
  assert.deepEqual([rt2.url, rt2.key, rt2.member, rt2.project], ["https://other.dev", "rk_other", "o@acme.dev", "mapped"]);
  // Everything from env (an install that embedded env vars keeps working).
  const rt3 = resolveRuntime({ cwd: repo, env: { REINS_URL: "http://x:1", REINS_KEY: "k", REINS_MEMBER: "m", REINS_PROJECT: "p" }, config });
  assert.deepEqual([rt3.url, rt3.key, rt3.member, rt3.project], ["http://x:1", "k", "m", "p"]);
});

test("resolveRuntime: repo map by git root (from a subfolder), then the old fallbacks", () => {
  const repo = gitRepo("fallback@acme.test");
  const config = { servers: { "https://r.dev": { token: "rk_cfg" } }, repos: { [repo]: { url: "https://r.dev", project: "mapped" } } };
  const rt = resolveRuntime({ cwd: join(repo, "src"), env: {}, config });
  assert.deepEqual([rt.url, rt.project, rt.key], ["https://r.dev", "mapped", "rk_cfg"]);
  assert.equal(rt.member, "fallback@acme.test", "no member on the server entry → git email");
  const other = gitRepo("other@acme.test");
  const fb = resolveRuntime({ cwd: other, env: {}, config });
  assert.deepEqual([fb.url, fb.project, fb.key, fb.member], ["http://localhost:4319", basename(other), undefined, "other@acme.test"]);
});

test("a folder mapped outside git covers its subfolders; a mapping without a project keeps folder names", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "reins-nogit-")));
  mkdirSync(join(base, "a", "b"), { recursive: true });
  const config = { servers: {}, repos: { [base]: { url: "https://r.dev" } } };
  assert.equal(repoEntry(config, join(base, "a", "b")).root, base);
  const rt = resolveRuntime({ cwd: join(base, "a", "b"), env: {}, config });
  assert.deepEqual([rt.url, rt.project], ["https://r.dev", "b"]);
});

// ---- the real hook and a real adapter, configured only by ~/.reins/config.json

let server;
let url;
const requests = [];
before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      requests.push({ path: req.url, body: JSON.parse(raw || "{}"), headers: req.headers });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url === "/api/hook/pack" ? { version: "v", text: "", shown: [] } : { ok: true }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function cleanEnv(home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const k of Object.keys(env)) if (k.startsWith("REINS_") && k !== "REINS_STATE_DIR") delete env[k];
  return env;
}
function runNode(args, { cwd, env, stdin = "" }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ["pipe", "ignore", "ignore"] });
    child.on("close", resolve);
    child.stdin.end(stdin);
  });
}
async function waitFor(pred, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const hit = pred(); if (hit) return hit; await new Promise((r) => setTimeout(r, 50)); }
  return null;
}

test("the Claude hook with no REINS_* env reads url, project, token and member from ~/.reins/config.json", async () => {
  const home = mkdtempSync(join(tmpdir(), "reins-home-"));
  const repo = gitRepo();
  saveConfig({ servers: { [url]: { token: "rk_from_config", member: "cfg@acme.dev" } }, repos: { [repo]: { url, project: "mapped" } } },
    join(home, ".reins", "config.json"));
  requests.length = 0;
  await runNode([join(CLI, "reins-hook.mjs")], {
    cwd: repo, env: cleanEnv(home),
    stdin: JSON.stringify({ hook_event_name: "SessionStart", session_id: "cfg-1", cwd: join(repo, "src") }),
  });
  const pack = requests.find((r) => r.path === "/api/hook/pack");
  assert.ok(pack, "the hook reached the configured server");
  assert.deepEqual([pack.body.project, pack.body.member, pack.headers["x-reins-key"]], ["mapped", "cfg@acme.dev", "rk_from_config"]);
});

test("the Codex adapter resolves the connection from the payload's cwd via ~/.reins/config.json", async () => {
  const home = mkdtempSync(join(tmpdir(), "reins-home-"));
  const repo = gitRepo();
  saveConfig({ servers: { [url]: { token: "rk_codex", member: "c@acme.dev" } }, repos: { [repo]: { url, project: "codex-proj" } } },
    join(home, ".reins", "config.json"));
  requests.length = 0;
  const payload = { type: "agent-turn-complete", "thread-id": "t1", cwd: repo, "input-messages": ["x"], "last-assistant-message": "Shipped it." };
  await runNode([join(CLI, "adapters", "codex.mjs"), JSON.stringify(payload)], { cwd: home, env: cleanEnv(home) });
  const ing = await waitFor(() => requests.find((r) => r.path === "/api/ingest"));
  assert.ok(ing);
  assert.deepEqual([ing.body.project, ing.body.member, ing.body.source, ing.headers["x-reins-key"]], ["codex-proj", "c@acme.dev", "codex", "rk_codex"]);
});
