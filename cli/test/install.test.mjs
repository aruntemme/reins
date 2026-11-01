import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "bin.mjs");

/** A clean environment rooted at a throwaway HOME (no inherited Reins/agent overrides). */
function envFor(home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" };
  for (const k of Object.keys(env)) if (k.startsWith("REINS_")) delete env[k];
  delete env.CODEX_HOME;
  delete env.XDG_CONFIG_HOME;
  return env;
}

function run(home, cwd, args) {
  return execFileSync(process.execPath, [BIN, ...args], {
    env: envFor(home), cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
}
/** A --global install (HOME doubles as the cwd). Points at a dead URL so the health check fails fast. */
const runInstall = (home, args) => run(home, home, ["install", "--global", "--url", "http://127.0.0.1:9", ...args]);
const runProjectInstall = (home, dir, args) => run(home, dir, ["install", "--url", "http://127.0.0.1:9", ...args]);

const jsonAt = (path) => JSON.parse(readFileSync(path, "utf8"));
const settingsFor = (home) => jsonAt(join(home, ".claude", "settings.json"));
const configFor = (home) => jsonAt(join(home, ".reins", "config.json"));

function allHooks(settings) {
  const out = [];
  for (const evt of Object.keys(settings.hooks || {})) for (const g of settings.hooks[evt]) for (const h of g.hooks || []) out.push(h);
  return out;
}
const allCommands = (s) => allHooks(s).map((h) => h.command);

test("install --agent codex writes Codex's own config.toml, and sweeps an old adapter hook out of Claude settings", () => {
  const home = mkdtempSync(join(tmpdir(), "reins-install-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  const foreign = "echo not-reins-hook";
  const legacy = `REINS_SOURCE=codex node "${join(home, ".reins", "adapters", "codex.mjs").replace(/\\/g, "/")}"`;
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
    hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: foreign }] }, { hooks: [{ type: "command", command: legacy }] }] },
  }));

  runInstall(home, ["--agent", "codex", "--me", "asha"]);

  const toml = readFileSync(join(home, ".codex", "config.toml"), "utf8");
  assert.match(toml, /^notify = \["node", "[^"]+\/\.reins\/adapters\/codex\.mjs"\]/m);
  const cmds = allCommands(settingsFor(home));
  assert.deepEqual(cmds, [foreign], "foreign hook kept, the 0.1.x adapter hook removed");
  assert.ok(existsSync(join(home, ".reins", "adapters", "codex.mjs")));
  assert.ok(existsSync(join(home, ".reins", "adapters", "_shared.mjs")));
  assert.ok(existsSync(join(home, ".reins", "lib", "capture.mjs")));
  assert.ok(existsSync(join(home, ".reins", "lib", "config.mjs")));
});

test("the hook command quotes the script path and pins shell:bash (Windows-safe)", () => {
  const home = mkdtempSync(join(tmpdir(), "reins-install-"));
  runInstall(home, ["--me", "asha"]);
  const ours = allHooks(settingsFor(home)).find((h) => h.command.includes("reins-hook.mjs"));
  assert.ok(ours, "hook entry must exist");
  assert.match(ours.command, /node "[^"]*reins-hook\.mjs"/, "script path must be quoted");
  const path = ours.command.match(/node "([^"]+)"/)[1];
  assert.ok(!path.includes("\\"), "path must use forward slashes");
  assert.equal(ours.shell, "bash", "hook must set shell: bash");
});

test("install --token stores the token in ~/.reins/config.json (0600), never in the hook command", () => {
  const home = mkdtempSync(join(tmpdir(), "reins-install-"));
  run(home, home, ["install", "--global", "--token", "rk_ingest_deadbeef", "--project", "demo", "--url", "http://127.0.0.1:9/"]);
  const cmd = allCommands(settingsFor(home)).find((c) => c.includes("reins-hook.mjs"));
  assert.equal(cmd.replace(/node "[^"]+"/, "node HOOK"), "REINS_SOURCE=claude-code node HOOK", "only REINS_SOURCE rides in the command");
  const cfg = configFor(home);
  assert.equal(cfg.version, 1);
  assert.equal(cfg.servers["http://127.0.0.1:9"].token, "rk_ingest_deadbeef", "trailing slash normalised");
  assert.deepEqual(cfg.repos[realpathSync(home)], { url: "http://127.0.0.1:9", project: "demo" });
  if (process.platform !== "win32") assert.equal(statSync(join(home, ".reins", "config.json")).mode & 0o777, 0o600);
});

test("install --key remains a working alias for the ingest token", () => {
  const home = mkdtempSync(join(tmpdir(), "reins-install-"));
  runInstall(home, ["--key", "legacy-secret"]);
  assert.equal(configFor(home).servers["http://127.0.0.1:9"].token, "legacy-secret");
  assert.ok(!allCommands(settingsFor(home)).some((c) => c.includes("legacy-secret")));
});

test("install --agent generic prints the command to wire (with the custom source) and writes no Claude settings", () => {
  const home = mkdtempSync(join(tmpdir(), "reins-install-"));
  const out = runInstall(home, ["--agent", "generic", "--source", "my-bot"]);
  assert.match(out, /REINS_SOURCE=my-bot node "[^"]+\/adapters\/generic\.mjs"/);
  assert.ok(!existsSync(join(home, ".claude", "settings.json")));
});

test("install with no --agent keeps Claude Code as the default", () => {
  const home = mkdtempSync(join(tmpdir(), "reins-install-"));
  runInstall(home, ["--me", "asha"]);
  const ours = allCommands(settingsFor(home)).find((c) => c.includes("reins-hook.mjs"));
  assert.match(ours, /^REINS_SOURCE=claude-code node /);
  assert.equal(configFor(home).servers["http://127.0.0.1:9"].member, "asha");
});

test("project install writes the machine-specific hook to settings.local.json, NOT the shared settings.json", () => {
  const home = mkdtempSync(join(tmpdir(), "reins-home-"));
  const proj = mkdtempSync(join(tmpdir(), "reins-proj-"));
  runProjectInstall(home, proj, ["--me", "asha"]);
  const localPath = join(proj, ".claude", "settings.local.json");
  assert.ok(existsSync(localPath), "settings.local.json must be written");
  assert.ok(allCommands(jsonAt(localPath)).some((c) => c.includes("reins-hook.mjs")));
  assert.ok(!existsSync(join(proj, ".claude", "settings.json")), "shared settings.json must not be created");
});

test("project install sweeps a stale Reins hook out of the committed shared settings.json, keeping foreign hooks", () => {
  const home = mkdtempSync(join(tmpdir(), "reins-home-"));
  const proj = mkdtempSync(join(tmpdir(), "reins-proj-"));
  mkdirSync(join(proj, ".claude"), { recursive: true });
  const stale = `REINS_SOURCE=claude-code node ${join(home, ".reins", "reins-hook.mjs")}`;
  const foreign = "echo keep-me";
  writeFileSync(join(proj, ".claude", "settings.json"), JSON.stringify({
    hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: foreign }] }, { hooks: [{ type: "command", command: stale }] }] },
  }, null, 2));
  runProjectInstall(home, proj, ["--me", "rui"]);
  const shared = allCommands(jsonAt(join(proj, ".claude", "settings.json")));
  assert.ok(shared.includes(foreign), "foreign hook must survive the sweep");
  assert.ok(!shared.some((c) => c.includes(".reins")), "our stale hook must be removed from the shared file");
  assert.ok(allCommands(jsonAt(join(proj, ".claude", "settings.local.json"))).some((c) => c.includes("reins-hook.mjs")));
});

test("installing several agents wires each in its own config; Claude hooks are untouched by the others", () => {
  const home = mkdtempSync(join(tmpdir(), "reins-install-"));
  runInstall(home, ["--agent", "claude-code,codex,opencode,aider"]);
  assert.equal(allCommands(settingsFor(home)).filter((c) => c.includes("reins-hook.mjs")).length, 5);
  assert.match(readFileSync(join(home, ".codex", "config.toml"), "utf8"), /adapters\/codex\.mjs/);
  assert.match(readFileSync(join(home, ".config", "opencode", "plugins", "reins.js"), "utf8"), /adapters\/opencode\.mjs/);
  assert.match(readFileSync(join(home, ".aider.conf.yml"), "utf8"), /^notifications-command: 'node "[^"]+\/adapters\/aider\.mjs"'/m);
});

test("--me with spaces/quotes is stored exactly in the config (no shell quoting involved)", () => {
  const home = mkdtempSync(join(tmpdir(), "reins-quote-"));
  runInstall(home, ["--me", "Asha O'Rao"]);
  assert.equal(configFor(home).servers["http://127.0.0.1:9"].member, "Asha O'Rao");
});

test("status masks a token embedded by an older install instead of printing it", () => {
  const home = mkdtempSync(join(tmpdir(), "reins-status-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  const hook = join(home, ".reins", "reins-hook.mjs").replace(/\\/g, "/");
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: "command", command: `REINS_KEY=rk_ingest_0123456789abcdef0123 REINS_SOURCE=claude-code node "${hook}"` }] }] },
  }));
  const out = run(home, home, ["status", "--url", "http://127.0.0.1:9"]);
  assert.ok(out.includes("REINS_KEY="), "the legacy command is still shown");
  assert.ok(!out.includes("rk_ingest_0123456789abcdef0123"), "the full token is not printed");
  assert.match(out, /Claude Code/);
});

test("install registers the context, pre-edit and touch hooks with edit-tool matchers", () => {
  const home = mkdtempSync(join(tmpdir(), "reins-install-"));
  runInstall(home, ["--me", "asha"]);
  const s = settingsFor(home);
  assert.deepEqual(Object.keys(s.hooks).sort(), ["PostToolUse", "PreToolUse", "SessionStart", "Stop", "UserPromptSubmit"]);
  for (const evt of ["PreToolUse", "PostToolUse"]) assert.equal(s.hooks[evt][0].matcher, "Edit|Write|MultiEdit|NotebookEdit");
  assert.equal(s.hooks.SessionStart[0].matcher, undefined);
  assert.ok(allHooks(s).every((h) => h.timeout === 10 && h.shell === "bash"));
});

test("re-running install upgrades an old install in place; uninstall removes every agent's wiring and keeps foreign config", () => {
  const home = mkdtempSync(join(tmpdir(), "reins-install-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  const old = `REINS_MEMBER=asha REINS_SOURCE=claude-code node "${join(home, ".reins", "reins-hook.mjs").replace(/\\/g, "/")}"`;
  const foreign = "echo foreign";
  const sharedForeign = "echo shares-a-group-with-ours";
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
    hooks: {
      UserPromptSubmit: [
        { hooks: [{ type: "command", command: foreign }] },
        { hooks: [{ type: "command", command: old, shell: "bash" }, { type: "command", command: sharedForeign }] },
      ],
      Stop: [{ hooks: [{ type: "command", command: old, shell: "bash" }] }],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: foreign }] }],
    },
  }));
  const codexBefore = 'model = "o4"\n\n[tui]\nnotifications = true\n';
  mkdirSync(join(home, ".codex"));
  writeFileSync(join(home, ".codex", "config.toml"), codexBefore);

  runInstall(home, ["--me", "asha"]);
  runInstall(home, ["--me", "asha"]);
  const s = settingsFor(home);
  for (const evt of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]) {
    const ours = s.hooks[evt].flatMap((g) => g.hooks).filter((h) => h.command.includes("reins-hook.mjs"));
    assert.equal(ours.length, 1, `${evt}: one Reins hook`);
    assert.ok(!ours[0].command.includes("REINS_MEMBER"), `${evt}: the old env-carrying command was replaced`);
  }
  const cmds = allCommands(s);
  assert.equal(cmds.filter((c) => c === foreign).length, 2, "both foreign hooks kept");
  assert.ok(cmds.includes(sharedForeign), "a foreign hook sharing a group with ours survives");
  assert.ok(s.hooks.PreToolUse.some((g) => g.matcher === "Bash"), "a foreign matcher group is untouched");

  runInstall(home, ["--agent", "codex"]);
  assert.ok(allCommands(settingsFor(home)).some((c) => c.includes("reins-hook.mjs")), "codex doesn't displace Claude Code");

  run(home, home, ["uninstall"]);
  const s3 = settingsFor(home);
  assert.ok(!allCommands(s3).some((c) => c.includes(".reins")));
  assert.deepEqual(allCommands(s3).sort(), [foreign, foreign, sharedForeign].sort());
  assert.equal(readFileSync(join(home, ".codex", "config.toml"), "utf8"), codexBefore, "config.toml restored byte for byte");
  // The saved sign-in survives a plain uninstall; --all forgets it.
  assert.ok(configFor(home).servers["http://127.0.0.1:9"]);
  run(home, home, ["uninstall", "--all"]);
  assert.deepEqual(configFor(home).servers, {});
});
