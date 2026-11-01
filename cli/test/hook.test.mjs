import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The REAL hook script, run as Claude Code runs it: a fresh node process fed a
// realistic hook payload on stdin. The server side is a local HTTP stub, so the
// test controls what it answers (and how slowly) and records what it was sent.
const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "..", "reins-hook.mjs");

const requests = [];
let respond = (_path, _body) => ({ status: 200, json: { ok: true } });
let server;
let url;

before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      requests.push({ path: req.url, body, headers: req.headers });
      const r = respond(req.url, body);
      if (r === "hang") return; // accept, never answer
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify(r.json));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

/** A throwaway git repo with one commit, on branch main. */
function gitRepo() {
  const dir = mkdtempSync(join(tmpdir(), "reins-repo-"));
  const g = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "asha@acme.test");
  g("config", "user.name", "Asha");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "auth.ts"), "export {}\n");
  g("add", ".");
  g("commit", "-q", "-m", "init");
  return dir;
}

/** Run the hook once; resolves {stdout, code, ms}. */
function runHook(payload, env = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [HOOK], {
      cwd: payload.cwd,
      env: { ...process.env, REINS_URL: url, REINS_MEMBER: "asha", REINS_PROJECT: "demo", REINS_KEY: "rk_ingest_test", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("close", (code) => resolve({ stdout, code, ms: Date.now() - t0 }));
    child.stdin.end(JSON.stringify(payload));
  });
}

async function waitFor(pred, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = pred();
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

const repo = gitRepo();
const stateDir = mkdtempSync(join(tmpdir(), "reins-state-"));
const base = { session_id: "sess-1", transcript_path: join(repo, "t.jsonl"), cwd: repo, permission_mode: "default" };

test("SessionStart injects the team pack as additionalContext and remembers what it showed", async () => {
  requests.length = 0;
  respond = (path) =>
    path === "/api/hook/pack"
      ? { status: 200, json: { version: "v1", text: "Reins team context for \"Demo\"\n- Ravi [active] — login page", shown: ["p:ravi", "g:abc"] } }
      : { status: 200, json: {} };
  const r = await runHook({ ...base, hook_event_name: "SessionStart", source: "startup" }, { REINS_STATE_DIR: stateDir });
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(out.hookSpecificOutput.additionalContext, /Ravi \[active\]/);
  const req = requests.find((x) => x.path === "/api/hook/pack");
  assert.deepEqual([req.body.mode, req.body.project, req.body.member], ["start", "demo", "asha"]);
  assert.equal(req.headers["x-reins-key"], "rk_ingest_test");
  const state = JSON.parse(readFileSync(join(stateDir, "s-sess-1.json"), "utf8"));
  assert.deepEqual(state.seen, ["p:ravi", "g:abc"]);
});

test("UserPromptSubmit still ships the intent, sends seen keys, and stays silent when nothing changed", async () => {
  requests.length = 0;
  respond = (path) => (path === "/api/hook/pack" ? { status: 200, json: { version: "v1", text: "", shown: [] } } : { status: 200, json: { ok: true } });
  const r = await runHook({ ...base, hook_event_name: "UserPromptSubmit", prompt: "add OAuth to the login page" }, { REINS_STATE_DIR: stateDir });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "", "no injection when nothing changed");
  const req = requests.find((x) => x.path === "/api/hook/pack");
  assert.equal(req.body.mode, "delta");
  assert.deepEqual(req.body.seen, ["p:ravi", "g:abc"]);
  assert.equal(req.body.query, "add OAuth to the login page");
  const ing = await waitFor(() => requests.find((x) => x.path === "/api/ingest"));
  assert.ok(ing, "the detached child posted the intent");
  assert.equal(ing.body.kind, "intent");
  assert.equal(ing.body.meta.git.branch, "main", "git state rides along");

  // Now a directive lands: the delta is injected, and its key joins the seen set.
  respond = (path) =>
    path === "/api/hook/pack"
      ? { status: 200, json: { version: "v2", text: "Reins update — team context changed since you last looked:\n- Lead directive (to you): freeze the schema", shown: ["d:1"] } }
      : { status: 200, json: { ok: true } };
  const r2 = await runHook({ ...base, hook_event_name: "UserPromptSubmit", prompt: "next step" }, { REINS_STATE_DIR: stateDir });
  const out = JSON.parse(r2.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(out.hookSpecificOutput.additionalContext, /freeze the schema/);
  assert.deepEqual(JSON.parse(readFileSync(join(stateDir, "s-sess-1.json"), "utf8")).seen, ["p:ravi", "g:abc", "d:1"]);
});

test("PreToolUse on an edit warns the model without a permission decision, with a repo-relative path and a short cache", async () => {
  requests.length = 0;
  respond = (path) =>
    path === "/api/hook/check"
      ? { status: 200, json: { warnings: [{ kind: "touch" }], text: "Reins heads-up before you edit src/auth.ts: Ravi edited src/auth.ts 2m ago. This is advisory and the edit is not blocked." } }
      : { status: 200, json: {} };
  const payload = {
    ...base, hook_event_name: "PreToolUse", tool_name: "Edit", tool_use_id: "toolu_1",
    tool_input: { file_path: join(repo, "src", "auth.ts"), old_string: "export {}", new_string: "export const x = 1", replace_all: false },
  };
  const r = await runHook(payload, { REINS_STATE_DIR: stateDir });
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.match(out.hookSpecificOutput.additionalContext, /Ravi edited src\/auth\.ts/);
  assert.equal(out.hookSpecificOutput.permissionDecision, undefined, "never blocks or changes permissions");
  assert.match(out.systemMessage, /Ravi edited/);
  assert.equal(requests.find((x) => x.path === "/api/hook/check").body.path, "src/auth.ts");
  // Same file again right away: answered from the local cache, no request.
  requests.length = 0;
  const again = await runHook(payload, { REINS_STATE_DIR: stateDir });
  assert.match(JSON.parse(again.stdout).hookSpecificOutput.additionalContext, /Ravi edited/);
  assert.equal(requests.length, 0);
  // A non-edit tool is ignored entirely.
  const bash = await runHook({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }, { REINS_STATE_DIR: stateDir });
  assert.equal(bash.stdout, "");
  assert.equal(requests.length, 0);
});

test("PostToolUse on Write records a repo-relative touch from a detached child", async () => {
  requests.length = 0;
  respond = () => ({ status: 200, json: { ok: true } });
  const r = await runHook({
    ...base, hook_event_name: "PostToolUse", tool_name: "Write", tool_use_id: "toolu_2",
    tool_input: { file_path: join(repo, "src", "new.ts"), content: "export {}" },
    tool_response: { filePath: join(repo, "src", "new.ts"), type: "create" },
  }, { REINS_STATE_DIR: stateDir });
  assert.equal(r.stdout, "");
  const touch = await waitFor(() => requests.find((x) => x.path === "/api/hook/touch"));
  assert.ok(touch, "touch posted");
  assert.deepEqual([touch.body.path, touch.body.tool, touch.body.member], ["src/new.ts", "Write", "asha"]);
  assert.equal(touch.body.meta.git.branch, "main");
});

test("fail open: server down or hanging → no output, exit 0, within the time budget", async () => {
  const dead = "http://127.0.0.1:1";
  const fresh = mkdtempSync(join(tmpdir(), "reins-state-"));
  const edit = { ...base, session_id: "sess-2", hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: join(repo, "src", "auth.ts") } };
  for (const [name, payload] of [
    ["SessionStart", { ...base, session_id: "sess-2", hook_event_name: "SessionStart", source: "startup" }],
    ["UserPromptSubmit", { ...base, session_id: "sess-2", hook_event_name: "UserPromptSubmit", prompt: "hi" }],
    ["PreToolUse", edit],
  ]) {
    const r = await runHook(payload, { REINS_URL: dead, REINS_STATE_DIR: fresh });
    assert.equal(r.code, 0, name);
    assert.equal(r.stdout, "", `${name}: silent when the server is down`);
    assert.ok(r.ms < 1500, `${name} took ${r.ms}ms with the server down`);
  }
  respond = () => "hang";
  const slowCtx = await runHook({ ...base, session_id: "sess-3", hook_event_name: "SessionStart", source: "startup" }, { REINS_STATE_DIR: fresh });
  assert.equal(slowCtx.stdout, "");
  assert.ok(slowCtx.ms < 800 + 700, `SessionStart gave up on a hung server in ${slowCtx.ms}ms (800ms budget + process start)`);
  const slowChk = await runHook({ ...edit, session_id: "sess-3" }, { REINS_STATE_DIR: fresh });
  assert.equal(slowChk.stdout, "");
  assert.ok(slowChk.ms < 300 + 700, `PreToolUse gave up on a hung server in ${slowChk.ms}ms (300ms budget + process start)`);
  assert.ok(!readdirSync(fresh).some((f) => f === "s-sess-3.json" && JSON.parse(readFileSync(join(fresh, f), "utf8")).checks), "a failed check is not cached");
});
