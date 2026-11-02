import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Session capture: every event names its session, source, branch, worktree and
// main repo root; noise prompts are not sent; a worktree maps to its repo's project.
// Real git repos + a real `git worktree`, the REAL hook script and adapters.
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..");
process.env.REINS_STATE_DIR = mkdtempSync(join(tmpdir(), "reins-cw-state-"));
const { gitIdentity, mainRootOf } = await import("../lib/git.mjs");
const { isNoisePrompt } = await import("../lib/capture.mjs");
const { repoEntry, resolveRuntime, saveConfig } = await import("../lib/config.mjs");

const requests = [];
let server;
let url;
before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      requests.push({ path: req.url, body: JSON.parse(raw || "{}"), headers: req.headers });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url === "/api/hook/pack" ? { version: "v1", text: "", shown: [] } : { ok: true }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

/** A repo on `main` plus a linked worktree on `feature/x` in a separate folder. */
function repoWithWorktree() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "reins-cw-repo-")));
  const g = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: "ignore" });
  g(dir, "init", "-q", "-b", "main");
  g(dir, "config", "user.email", "asha@acme.test");
  g(dir, "config", "user.name", "Asha");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "auth.ts"), "export {}\n");
  g(dir, "add", ".");
  g(dir, "commit", "-q", "-m", "init");
  const wt = join(realpathSync(mkdtempSync(join(tmpdir(), "reins-cw-wt-"))), "checkout");
  g(dir, "worktree", "add", "-q", "-b", "feature/x", wt);
  return { main: dir, wt };
}
const { main, wt } = repoWithWorktree();

function cleanEnv(home, extra = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, REINS_STATE_DIR: join(home, ".reins", "state"), ...extra };
  for (const k of Object.keys(env)) if (k.startsWith("REINS_") && !(k in extra) && k !== "REINS_STATE_DIR") delete env[k];
  return env;
}
function runNode(args, { cwd, env, stdin }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(stdin ?? "");
  });
}
async function waitFor(pred, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const hit = pred(); if (hit) return hit; await new Promise((r) => setTimeout(r, 50)); }
  return null;
}

test("gitIdentity names the branch, the worktree and the main repo root, in the main checkout and in a worktree", () => {
  assert.deepEqual(gitIdentity(main), { branch: "main", worktree: main, repo_root: main });
  assert.deepEqual(gitIdentity(join(main, "src")), { branch: "main", worktree: main, repo_root: main });
  assert.deepEqual(gitIdentity(wt), { branch: "feature/x", worktree: wt, repo_root: main });
  assert.deepEqual(gitIdentity(tmpdir()), {}, "outside a repo there is nothing to name");
  assert.equal(mainRootOf("/a/b/.git", "/a/b"), "/a/b");
  assert.equal(mainRootOf("/a/.git/modules/sub", "/a/sub"), "/a/sub", "a submodule has no main root of its own");
});

test("a worktree resolves to the project of its main repo; the worktree's own mapping wins", () => {
  const config = { servers: {}, repos: { [main]: { url, project: "shop" } } };
  assert.equal(repoEntry(config, wt).project, "shop");
  assert.equal(repoEntry(config, wt).root, main);
  assert.equal(repoEntry(config, join(wt, "src")).project, "shop");
  assert.equal(resolveRuntime({ cwd: wt, env: {}, config }).project, "shop");
  const own = { servers: {}, repos: { [main]: { url, project: "shop" }, [wt]: { url, project: "spike" } } };
  assert.equal(repoEntry(own, wt).project, "spike");
  assert.equal(repoEntry(own, main).project, "shop");
});

test("isNoisePrompt: system-injected blocks and filler words are noise, real instructions are not", () => {
  for (const t of [
    "", "   ", "<task-notification>done</task-notification>", "<system-reminder>x</system-reminder>", "<command-name>/clear</command-name>",
    "<command-message>init</command-message>", "<local-command-stdout>ok</local-command-stdout>", "Caveat: The messages below were generated by the user",
    "continue", "Continue.", "go on", "Go ahead!", "ok", "OK.", "okay", "yes", "Y", "no", "n", "next", "check now", "Check   now?", "status", "status?", "proceed", "Done.", "thanks", "...thanks!",
  ]) assert.equal(isNoisePrompt(t), true, JSON.stringify(t));
  for (const t of [
    "add OAuth to the login page", "continue the migration of the users table", "yes, and also rename it", "next step", "fix the status page", "ok so what does this do?",
  ]) assert.equal(isNoisePrompt(t), false, JSON.stringify(t));
});

const base = (cwd) => ({ session_id: "sess-wt", transcript_path: join(cwd, "t.jsonl"), cwd });
const hookEnv = (home) => cleanEnv(home, { REINS_URL: url, REINS_MEMBER: "asha", REINS_PROJECT: "demo", REINS_KEY: "rk_ingest_t" });

test("a real prompt from a worktree: the intent event and the pack request both name session, source, branch, worktree, repo_root", async () => {
  const home = mkdtempSync(join(tmpdir(), "reins-cw-home-"));
  requests.length = 0;
  await runNode([join(CLI, "reins-hook.mjs")], {
    cwd: wt, env: hookEnv(home),
    stdin: JSON.stringify({ ...base(wt), hook_event_name: "UserPromptSubmit", prompt: "add OAuth to the login page" }),
  });
  const ing = await waitFor(() => requests.find((r) => r.path === "/api/ingest"));
  assert.ok(ing, "intent shipped");
  const want = { session: "sess-wt", source: "claude-code", branch: "feature/x", worktree: wt, repo_root: main };
  for (const [k, v] of Object.entries(want)) assert.equal(ing.body[k], v, `ingest.${k}`);
  assert.equal(ing.body.meta.worktree, wt);
  const pack = requests.find((r) => r.path === "/api/hook/pack");
  for (const [k, v] of Object.entries(want)) assert.equal(pack.body[k], v, `pack.${k}`);
  assert.equal(pack.body.event, "UserPromptSubmit");
});

test("a noise prompt sends no intent event (and no prompt text) but the pack request still touches the session", async () => {
  const home = mkdtempSync(join(tmpdir(), "reins-cw-home-"));
  for (const prompt of ["<system-reminder>be careful</system-reminder>", "continue", "ok"]) {
    requests.length = 0;
    await runNode([join(CLI, "reins-hook.mjs")], {
      cwd: wt, env: hookEnv(home),
      stdin: JSON.stringify({ ...base(wt), hook_event_name: "UserPromptSubmit", prompt }),
    });
    const pack = await waitFor(() => requests.find((r) => r.path === "/api/hook/pack"));
    assert.ok(pack, `${prompt}: pack still asked`);
    assert.equal(pack.body.session, "sess-wt");
    assert.equal(pack.body.worktree, wt);
    assert.ok(!pack.body.query, "the noise text is not sent as a query");
    await new Promise((r) => setTimeout(r, 400)); // a detached sender would have landed by now
    assert.ok(!requests.some((r) => r.path === "/api/ingest"), `${prompt}: no ingest event`);
  }
});

test("Stop, edit touches and the Codex / OpenCode adapters carry the same session fields; adapters drop noise intents", async () => {
  const home = mkdtempSync(join(tmpdir(), "reins-cw-home-"));
  // A mapping by the main repo only: a worktree cwd must still land on the project.
  saveConfig({ servers: { [url]: { token: "rk_cfg", member: "cfg@acme.dev" } }, repos: { [main]: { url, project: "mapped" } } }, join(home, ".reins", "config.json"));
  const env = cleanEnv(home);

  requests.length = 0;
  writeFileSync(join(wt, "t.jsonl"), JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Wired the login route." }] } }) + "\n");
  await runNode([join(CLI, "reins-hook.mjs")], { cwd: wt, env, stdin: JSON.stringify({ ...base(wt), hook_event_name: "Stop" }) });
  const stop = await waitFor(() => requests.find((r) => r.path === "/api/ingest"));
  assert.deepEqual([stop.body.project, stop.body.kind, stop.body.session, stop.body.branch, stop.body.worktree, stop.body.repo_root],
    ["mapped", "summary", "sess-wt", "feature/x", wt, main]);
  assert.equal(stop.headers["x-reins-key"], "rk_cfg");

  requests.length = 0;
  await runNode([join(CLI, "reins-hook.mjs")], {
    cwd: wt, env,
    stdin: JSON.stringify({ ...base(wt), hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: join(wt, "src", "auth.ts") } }),
  });
  const touch = await waitFor(() => requests.find((r) => r.path === "/api/hook/touch"));
  assert.deepEqual([touch.body.path, touch.body.session, touch.body.source, touch.body.branch, touch.body.worktree, touch.body.repo_root],
    ["src/auth.ts", "sess-wt", "claude-code", "feature/x", wt, main]);

  requests.length = 0;
  await runNode([join(CLI, "adapters", "codex.mjs"), JSON.stringify({ type: "agent-turn-complete", "thread-id": "t-9", cwd: wt, "last-assistant-message": "Done with the route." })], { cwd: home, env });
  const codex = await waitFor(() => requests.find((r) => r.path === "/api/ingest"));
  assert.deepEqual([codex.body.project, codex.body.source, codex.body.session, codex.body.branch, codex.body.worktree, codex.body.repo_root],
    ["mapped", "codex", "t-9", "feature/x", wt, main]);

  // An OpenCode user prompt that is just "continue" is not an event.
  requests.length = 0;
  await runNode([join(CLI, "adapters", "opencode.mjs")], {
    cwd: home, env,
    stdin: JSON.stringify({ type: "message.sent", properties: { role: "user", text: "continue", sessionID: "oc-1" }, cwd: wt }),
  });
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(!requests.some((r) => r.path === "/api/ingest"), "noise intent dropped");
  await runNode([join(CLI, "adapters", "opencode.mjs")], {
    cwd: home, env,
    stdin: JSON.stringify({ type: "message.sent", properties: { role: "user", text: "rename the login route", sessionID: "oc-1" }, cwd: wt }),
  });
  const oc = await waitFor(() => requests.find((r) => r.path === "/api/ingest"));
  assert.deepEqual([oc.body.source, oc.body.session, oc.body.worktree, oc.body.repo_root], ["opencode", "oc-1", wt, main]);
});
