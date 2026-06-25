import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "bin.mjs");

/** Run the installer with HOME pointed at a throwaway dir (drives --global). */
function runInstall(home, args) {
  return execFileSync(process.execPath, [BIN, "install", "--global", ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    cwd: home,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function settingsFor(home) {
  return JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
}

/** Collect every command string across all hook events. */
function allCommands(settings) {
  const out = [];
  for (const evt of Object.keys(settings.hooks || {})) {
    for (const group of settings.hooks[evt]) {
      for (const h of group.hooks || []) out.push(h.command);
    }
  }
  return out;
}

test("install --agent codex writes a merged settings.json with REINS_SOURCE and the adapter path", () => {
  const home = mkdtempSync(join(tmpdir(), "reins-install-"));
  // Seed a foreign hook we must NOT clobber.
  mkdirSync(join(home, ".claude"), { recursive: true });
  const foreign = "echo not-reins-hook";
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: foreign }] }] } }, null, 2),
  );

  runInstall(home, ["--agent", "codex", "--me", "asha"]);

  const settings = settingsFor(home);
  const cmds = allCommands(settings);

  // Foreign hook survives.
  assert.ok(cmds.includes(foreign), "foreign hook must be preserved");

  // Our codex hook is present, carries the right source, and points at the adapter.
  const ours = cmds.find((c) => c.includes("adapters/codex.mjs"));
  assert.ok(ours, "codex adapter command must be written");
  assert.match(ours, /REINS_SOURCE=codex/);
  assert.match(ours, /REINS_MEMBER=asha/);

  // The adapter and its shared deps were actually copied to ~/.reins.
  assert.ok(existsSync(join(home, ".reins", "adapters", "codex.mjs")));
  assert.ok(existsSync(join(home, ".reins", "adapters", "_shared.mjs")));
  assert.ok(existsSync(join(home, ".reins", "lib", "capture.mjs")));
});

test("install --token wires the ingest token into the hook command as REINS_KEY", () => {
  const home = mkdtempSync(join(tmpdir(), "reins-install-"));
  runInstall(home, ["--token", "rk_ingest_deadbeef", "--project", "demo", "--url", "http://localhost:4350"]);
  const ours = allCommands(settingsFor(home)).find((c) => c.includes("reins-hook.mjs"));
  assert.ok(ours, "claude hook command must be written");
  assert.match(ours, /REINS_KEY=rk_ingest_deadbeef/, "the --token value must ride as REINS_KEY (sent as x-reins-key)");
});

test("install --key remains a working alias for the ingest secret", () => {
  const home = mkdtempSync(join(tmpdir(), "reins-install-"));
  runInstall(home, ["--key", "legacy-secret"]);
  const ours = allCommands(settingsFor(home)).find((c) => c.includes("reins-hook.mjs"));
  assert.match(ours, /REINS_KEY=legacy-secret/);
});

test("install --agent generic --source uses the custom source label", () => {
  const home = mkdtempSync(join(tmpdir(), "reins-install-"));
  runInstall(home, ["--agent", "generic", "--source", "my-bot"]);
  const cmds = allCommands(settingsFor(home));
  const ours = cmds.find((c) => c.includes("adapters/generic.mjs"));
  assert.ok(ours, "generic adapter command must be written");
  assert.match(ours, /REINS_SOURCE=my-bot/);
});

test("install with no --agent keeps Claude Code as the default", () => {
  const home = mkdtempSync(join(tmpdir(), "reins-install-"));
  runInstall(home, ["--me", "asha"]);
  const cmds = allCommands(settingsFor(home));
  const ours = cmds.find((c) => c.includes("reins-hook.mjs"));
  assert.ok(ours, "claude hook command must be written by default");
  assert.match(ours, /REINS_SOURCE=claude-code/);
});

test("installing a second agent replaces ours but keeps foreign hooks", () => {
  const home = mkdtempSync(join(tmpdir(), "reins-install-"));
  runInstall(home, ["--agent", "codex"]);
  runInstall(home, ["--agent", "opencode"]);
  const cmds = allCommands(settingsFor(home));
  // Only one of our hooks per event: opencode replaced codex.
  assert.ok(cmds.some((c) => c.includes("adapters/opencode.mjs")));
  assert.ok(!cmds.some((c) => c.includes("adapters/codex.mjs")), "previous reins agent should be replaced");
});
