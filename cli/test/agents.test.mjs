import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  installAgent, uninstallAgent, agentStatus, detectAgents, scanToml, upsertCodexNotify, removeCodexNotify,
  codexNotifyLine, upsertAider, removeAider, opencodePluginSource,
} from "../lib/agents.mjs";

/** A throwaway home + repo dir, with an env that has no agent overrides. */
function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "reins-agents-home-"));
  const repo = mkdtempSync(join(tmpdir(), "reins-agents-repo-"));
  return { home, repo, o: { home, cwd: repo, dir: repo, env: { PATH: "" } } };
}
const read = (p) => readFileSync(p, "utf8");

/** Import plugin source as an ES module (opencode runs it under Bun; Node needs .mjs to be sure). */
let n = 0;
function importAsModule(src, dir) {
  const file = join(dir, `plugin-${n++}.mjs`);
  writeFileSync(file, src);
  return import(pathToFileURL(file).href);
}

// ---------------------------------------------------------------- TOML scanning

test("scanToml finds the first real table header, skipping brackets inside arrays and strings", () => {
  const lines = [
    'model = "o4"',
    "tags = [",
    '  ["a", "b"],',
    "  [1, 2],",
    "]",
    'prompt = """',
    "[not-a-table]",
    '"""',
    "# the next table",
    "[profiles.fast]",
    'notify = ["x"]',
  ];
  const r = scanToml(lines);
  assert.equal(r.header, 9);
  assert.deepEqual(r.notify, [], "a notify inside a table is not top-level");
});

test("our notify goes before the first table (and its comment block), never inside a table", () => {
  const o = { home: "/home/u" };
  const before = 'model = "o4"\n\n# profiles\n[profiles.fast]\nmodel = "o3"\n';
  const { text } = upsertCodexNotify(before, o);
  const lines = text.split("\n");
  assert.equal(lines[2], codexNotifyLine(o));
  assert.equal(lines[3], "# profiles");
  assert.equal(scanToml(lines).notify.length, 1);
  // Idempotent: a second run changes nothing.
  const again = upsertCodexNotify(text, o);
  assert.equal(again.text, text);
  assert.equal(again.changed, false);
  // Removal restores the original byte for byte.
  assert.equal(removeCodexNotify(text, o).text, before);
});

test("notify into an empty / table-less config.toml, and a multi-line notify of ours is replaced in place", () => {
  const o = { home: "/home/u" };
  assert.equal(upsertCodexNotify("", o).text, `${codexNotifyLine(o)}\n`);
  assert.equal(upsertCodexNotify('a = 1\n', o).text, `a = 1\n${codexNotifyLine(o)}\n`);
  const multi = `a = 1\nnotify = [\n  "node",\n  "/home/u/.reins/adapters/codex.mjs",\n]\n[t]\n`;
  const r = upsertCodexNotify(multi, o);
  assert.equal(r.text, `a = 1\n${codexNotifyLine(o)}\n[t]\n`);
});

test("a foreign top-level notify is a conflict: the file is left alone and the fix is spelled out", () => {
  const o = { home: "/home/u" };
  const before = 'notify = ["python3", "/home/u/notify.py"]\n';
  const r = upsertCodexNotify(before, o);
  assert.equal(r.text, before);
  assert.match(r.conflict, /notify\.py/);
});

// ---------------------------------------------------------------- Codex installer on disk

test("codex: fresh install, idempotent re-run, foreign keys preserved, uninstall removes only ours", () => {
  const { home, o } = sandbox();
  mkdirSync(join(home, ".codex"));
  const path = join(home, ".codex", "config.toml");
  const before = '# my settings\nmodel = "gpt-5"\napproval_policy = "on-request"\n\n[mcp_servers.docs]\ncommand = "docs-mcp"\nargs = ["--port", "1"]\n';
  writeFileSync(path, before);
  const r = installAgent("codex", o);
  assert.equal(r.conflict, undefined);
  const after = read(path);
  assert.ok(after.indexOf("notify = ") < after.indexOf("[mcp_servers.docs]"), "top-level, before the first table");
  installAgent("codex", o);
  assert.equal(read(path), after, "re-running doesn't duplicate");
  assert.deepEqual(agentStatus("codex", o).map((r) => r.note), ["notify", "Reins tools (MCP)"]);
  assert.deepEqual(uninstallAgent("codex", o), [path]);
  assert.equal(read(path), before);
  assert.deepEqual(agentStatus("codex", o), []);
});

test("codex: a foreign notify is left untouched and reported", () => {
  const { home, o } = sandbox();
  mkdirSync(join(home, ".codex"));
  const path = join(home, ".codex", "config.toml");
  writeFileSync(path, 'notify = ["terminal-notifier"]\n');
  const r = installAgent("codex", o);
  assert.match(r.conflict, /terminal-notifier/);
  assert.match(r.conflict, /adapters\/codex\.mjs/, "says exactly what to change it to");
  // The notify slot is theirs; the Reins tools are a separate table and still get wired.
  assert.ok(read(path).startsWith('notify = ["terminal-notifier"]\n'));
  assert.equal(r.tools, true);
  assert.equal(agentStatus("codex", o)[0].foreign, true);
  assert.deepEqual(uninstallAgent("codex", o), [path]);
  assert.equal(read(path), 'notify = ["terminal-notifier"]\n');
});

test("codex honours CODEX_HOME", () => {
  const { home, o } = sandbox();
  const codexHome = join(home, "elsewhere");
  installAgent("codex", { ...o, env: { PATH: "", CODEX_HOME: codexHome } });
  assert.ok(existsSync(join(codexHome, "config.toml")));
  assert.ok(!existsSync(join(home, ".codex")));
});

// ---------------------------------------------------------------- OpenCode

test("opencode: writes a global plugin, idempotent, never overwrites a foreign reins.js, uninstall removes ours", async () => {
  const { home, o } = sandbox();
  const path = join(home, ".config", "opencode", "plugins", "reins.js");
  installAgent("opencode", o);
  const src = read(path);
  assert.equal(src, opencodePluginSource(o));
  installAgent("opencode", o);
  assert.equal(read(path), src);
  // The plugin is a real module exporting one async plugin function returning an event hook.
  const mod = await importAsModule(src, home);
  assert.deepEqual(Object.keys(mod), ["ReinsPlugin"]);
  const hooks = await mod.ReinsPlugin({ directory: home, worktree: home });
  assert.equal(typeof hooks.event, "function");
  await hooks.event({ event: { type: "server.connected", properties: {} } }); // ignored, no throw
  assert.deepEqual(uninstallAgent("opencode", o), [path, join(home, ".config", "opencode", "opencode.json")]);
  assert.ok(!existsSync(path));

  writeFileSync(path, "export const Mine = async () => ({})\n");
  const r = installAgent("opencode", o);
  assert.match(r.conflict, /isn't ours/);
  assert.equal(read(path), "export const Mine = async () => ({})\n");
  assert.equal(r.tools, true, "the plugin slot is theirs, the Reins tools are still wired");
  // Only the tools entry is ours to remove; their plugin file stays.
  assert.deepEqual(uninstallAgent("opencode", o), [join(home, ".config", "opencode", "opencode.json")]);
  assert.ok(existsSync(path));
});

test("opencode plugin ships the user's prompt once and the assistant's final text on idle, to the adapter", async () => {
  const { home, o } = sandbox();
  // Point the plugin at a stand-in adapter that records what it receives, so the
  // plugin's own event handling (the thing under test) runs for real.
  installAgent("opencode", o);
  const path = join(home, ".config", "opencode", "plugins", "reins.js");
  const out = join(home, "received.jsonl");
  const recorder = join(home, "recorder.mjs");
  writeFileSync(recorder, `import { appendFileSync, readFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(out)}, readFileSync(0, "utf8") + "\\n");\n`);
  const mod = await importAsModule(read(path).replace(/const ADAPTER = .*;/, `const ADAPTER = ${JSON.stringify(recorder)};`), home);
  const { event } = await mod.ReinsPlugin({ directory: "/work/repo" });
  const ev = (type, properties) => event({ event: { type, properties } });
  await ev("message.updated", { info: { id: "u1", sessionID: "s1", role: "user" } });
  await ev("message.part.updated", { part: { id: "p1", messageID: "u1", sessionID: "s1", type: "text", text: "add OAuth" } });
  await ev("message.part.updated", { part: { id: "p1", messageID: "u1", sessionID: "s1", type: "text", text: "add OAuth" } });
  await ev("message.updated", { info: { id: "a1", sessionID: "s1", role: "assistant" } });
  await ev("message.part.updated", { part: { id: "p2", messageID: "a1", sessionID: "s1", type: "text", text: "Add" } });
  await ev("message.part.updated", { part: { id: "p2", messageID: "a1", sessionID: "s1", type: "text", text: "Added OAuth." } });
  await ev("message.part.updated", { part: { id: "p3", messageID: "a1", sessionID: "s1", type: "text", text: "ctx", synthetic: true } });
  await ev("session.idle", { sessionID: "s1" });
  const deadline = Date.now() + 5000;
  let rows = [];
  while (Date.now() < deadline) {
    rows = existsSync(out) ? read(out).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    if (rows.length >= 2) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await new Promise((r) => setTimeout(r, 200)); // nothing else arrives
  rows = read(out).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  rows.sort((a, b) => a.type.localeCompare(b.type));
  assert.deepEqual(rows, [
    { type: "message.sent", properties: { role: "user", text: "add OAuth", sessionID: "s1" }, cwd: "/work/repo" },
    { type: "session.idle", properties: { role: "assistant", text: "Added OAuth.", sessionID: "s1" }, cwd: "/work/repo" },
  ]);
});

// ---------------------------------------------------------------- Aider

test("aider: fresh, idempotent, foreign keys kept, uninstall removes only ours", () => {
  const { home, o } = sandbox();
  const path = join(home, ".aider.conf.yml");
  const before = "model: sonnet\ndark-mode: true\n";
  writeFileSync(path, before);
  installAgent("aider", o);
  const after = read(path);
  assert.match(after, /^notifications: true {2}# added by reins-hook$/m);
  assert.match(after, /^notifications-command: 'node "[^"]+\/\.reins\/adapters\/aider\.mjs"' {2}# added by reins-hook$/m);
  assert.ok(after.startsWith(before));
  installAgent("aider", o);
  assert.equal(read(path), after);
  assert.deepEqual(uninstallAgent("aider", o), [path]);
  assert.equal(read(path), before);
});

test("aider: an existing `notifications: true` is reused; a foreign command or `false` is a conflict left alone", () => {
  const o = { home: "/home/u" };
  const reuse = upsertAider("notifications: true\n", o);
  assert.equal(reuse.text.match(/^notifications:/gm).length, 1, "doesn't add a second notifications key");
  assert.match(reuse.text, /^notifications-command: /m);
  assert.equal(removeAider(reuse.text).text, "notifications: true\n");

  const off = upsertAider("notifications: false\n", o);
  assert.equal(off.text, "notifications: false\n");
  assert.match(off.conflict.join("\n"), /notifications: true/);

  const cmd = upsertAider("notifications: true\nnotifications-command: say done\n", o);
  assert.match(cmd.conflict.join("\n"), /say done/);
});

// ---------------------------------------------------------------- Claude Code

test("claude-code: repo scope writes settings.local.json; global writes ~/.claude/settings.json; uninstall clears both", () => {
  const { home, repo, o } = sandbox();
  installAgent("claude-code", o);
  installAgent("claude-code", { ...o, scope: "global" });
  const local = JSON.parse(read(join(repo, ".claude", "settings.local.json")));
  const global = JSON.parse(read(join(home, ".claude", "settings.json")));
  for (const s of [local, global]) {
    const cmd = s.hooks.Stop[0].hooks[0].command;
    assert.match(cmd, /^REINS_SOURCE=claude-code node "[^"]+\/\.reins\/reins-hook\.mjs"$/);
  }
  assert.equal(agentStatus("claude-code", o).length, 3, "two hook files + the Reins tools in ~/.claude.json");
  uninstallAgent("claude-code", o);
  assert.deepEqual(JSON.parse(read(join(home, ".claude", "settings.json"))).hooks, {});
  assert.deepEqual(agentStatus("claude-code", o), []);
});

test("claude-code: invalid JSON in settings is refused, not overwritten", () => {
  const { repo, o } = sandbox();
  mkdirSync(join(repo, ".claude"));
  writeFileSync(join(repo, ".claude", "settings.local.json"), "{ nope");
  assert.throws(() => installAgent("claude-code", o), /not valid JSON/);
  assert.equal(read(join(repo, ".claude", "settings.local.json")), "{ nope");
});

// ---------------------------------------------------------------- detection

test("detectAgents: binaries on PATH and config dirs; the rest are not found", () => {
  const { home } = sandbox();
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "codex"), "#!/bin/sh\n");
  chmodSync(join(bin, "codex"), 0o755);
  mkdirSync(join(home, ".claude"));
  const d = Object.fromEntries(detectAgents({ home, env: { PATH: bin } }).map((x) => [x.id, x]));
  assert.equal(d.codex.detected, true);
  assert.match(d.codex.how, /on PATH/);
  assert.equal(d["claude-code"].detected, true);
  assert.equal(d.opencode.detected, false);
  assert.equal(d.aider.how, "not found");
});
