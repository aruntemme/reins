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

/** Run a PROJECT install (no --global): HOME holds ~/.reins, cwd is the repo. */
function runProjectInstall(home, projectDir, args) {
  return execFileSync(process.execPath, [BIN, "install", ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    cwd: projectDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function jsonAt(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Collect every command string across all hook events. */
function allCommands(settings) {
  return allHooks(settings).map((h) => h.command);
}

/** Collect every hook object (so tests can assert shell/type, not just command). */
function allHooks(settings) {
  const out = [];
  for (const evt of Object.keys(settings.hooks || {})) {
    for (const group of settings.hooks[evt]) {
      for (const h of group.hooks || []) out.push(h);
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

test("the hook command quotes the script path and pins shell:bash (Windows-safe)", () => {
  const home = mkdtempSync(join(tmpdir(), "reins-install-"));
  runInstall(home, ["--me", "asha"]);
  const ours = allHooks(settingsFor(home)).find((h) => h.command.includes("reins-hook.mjs"));
  assert.ok(ours, "hook entry must exist");
  // Path is wrapped in double quotes: ... node "<path>/reins-hook.mjs"
  assert.match(ours.command, /node "[^"]*reins-hook\.mjs"/, "script path must be quoted");
  // No backslashes in the embedded path (bash strips them on Windows).
  const path = ours.command.match(/node "([^"]+)"/)[1];
  assert.ok(!path.includes("\\"), "path must use forward slashes");
  // Pin bash so the VAR=val env-prefix works on Windows too.
  assert.equal(ours.shell, "bash", "hook must set shell: bash");
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

test("project install writes the machine-specific hook to settings.local.json, NOT the shared settings.json", () => {
  const home = mkdtempSync(join(tmpdir(), "reins-home-"));
  const proj = mkdtempSync(join(tmpdir(), "reins-proj-"));
  runProjectInstall(home, proj, ["--me", "asha"]);

  const localPath = join(proj, ".claude", "settings.local.json");
  const sharedPath = join(proj, ".claude", "settings.json");

  // Our hook lands in the personal, git-ignored file...
  assert.ok(existsSync(localPath), "settings.local.json must be written");
  const ours = allCommands(jsonAt(localPath)).find((c) => c.includes("reins-hook.mjs"));
  assert.ok(ours, "hook command must be in settings.local.json");
  assert.match(ours, /REINS_MEMBER=asha/);
  // ...and the SHARED settings.json is not created with our machine path.
  assert.ok(!existsSync(sharedPath), "shared settings.json must not be created");
});

test("project install sweeps a stale Reins hook out of the committed shared settings.json, keeping foreign hooks", () => {
  const home = mkdtempSync(join(tmpdir(), "reins-home-"));
  const proj = mkdtempSync(join(tmpdir(), "reins-proj-"));
  mkdirSync(join(proj, ".claude"), { recursive: true });

  // Simulate an older version that committed our absolute path into the shared
  // file (the exact thing that breaks teammates), alongside a foreign hook.
  const stale = `REINS_SOURCE=claude-code node ${join(home, ".reins", "reins-hook.mjs")}`;
  const foreign = "echo keep-me";
  writeFileSync(
    join(proj, ".claude", "settings.json"),
    JSON.stringify(
      {
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: "command", command: foreign }] },
            { hooks: [{ type: "command", command: stale }] },
          ],
        },
      },
      null,
      2,
    ),
  );

  runProjectInstall(home, proj, ["--me", "rui"]);

  const shared = allCommands(jsonAt(join(proj, ".claude", "settings.json")));
  assert.ok(shared.includes(foreign), "foreign hook must survive the sweep");
  assert.ok(!shared.some((c) => c.includes(".reins")), "our stale hook must be removed from the shared file");

  const local = allCommands(jsonAt(join(proj, ".claude", "settings.local.json")));
  assert.ok(local.some((c) => c.includes("reins-hook.mjs")), "the working hook now lives in settings.local.json");
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

test("--me with spaces/quotes is shell-quoted so bash hands the hook the exact value", () => {
  const home = mkdtempSync(join(tmpdir(), "reins-quote-"));
  runInstall(home, ["--me", "Asha O'Rao", "--url", "http://localhost:4319"]);
  const ours = allCommands(settingsFor(home)).find((c) => c.includes("reins-hook.mjs"));
  assert.ok(ours);
  // Run the env prefix through real bash, swapping the hook for a printer.
  const probe = ours.replace(/node "[^"]+"/, `node -e 'process.stdout.write(process.env.REINS_MEMBER)'`);
  const got = execFileSync("bash", ["-c", probe], { encoding: "utf8" });
  assert.equal(got, "Asha O'Rao");
});

test("status masks the ingest token instead of printing it", () => {
  const home = mkdtempSync(join(tmpdir(), "reins-status-"));
  runInstall(home, ["--token", "rk_ingest_0123456789abcdef0123", "--url", "http://127.0.0.1:9"]);
  const out = execFileSync(process.execPath, [BIN, "status", "--url", "http://127.0.0.1:9"], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    cwd: home,
    encoding: "utf8",
  });
  assert.ok(out.includes("REINS_KEY="), "the command is still shown");
  assert.ok(!out.includes("rk_ingest_0123456789abcdef0123"), "the full token is not printed");
});

test("install registers the context, pre-edit and touch hooks with edit-tool matchers", () => {
  const home = mkdtempSync(join(tmpdir(), "reins-install-"));
  runInstall(home, ["--me", "asha"]);
  const s = settingsFor(home);
  assert.deepEqual(Object.keys(s.hooks).sort(), ["PostToolUse", "PreToolUse", "SessionStart", "Stop", "UserPromptSubmit"]);
  for (const evt of ["PreToolUse", "PostToolUse"]) {
    assert.equal(s.hooks[evt][0].matcher, "Edit|Write|MultiEdit|NotebookEdit", `${evt} limited to edit tools`);
  }
  assert.equal(s.hooks.SessionStart[0].matcher, undefined);
  assert.ok(allHooks(s).every((h) => h.timeout === 10 && h.shell === "bash"));
});

test("re-running install upgrades an old install in place: no duplicates, foreign hooks kept (even in a shared group)", () => {
  const home = mkdtempSync(join(tmpdir(), "reins-install-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  const old = `REINS_MEMBER=asha REINS_SOURCE=claude-code node "${join(home, ".reins", "reins-hook.mjs").replace(/\\/g, "/")}"`;
  const foreign = "echo foreign";
  const sharedForeign = "echo shares-a-group-with-ours";
  // What reins-hook 0.1.6 wrote: ours on UserPromptSubmit + Stop only.
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
  runInstall(home, ["--me", "asha"]);
  runInstall(home, ["--me", "asha"]); // twice: still exactly one of ours per event
  const s = settingsFor(home);
  for (const evt of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]) {
    const ours = s.hooks[evt].flatMap((g) => g.hooks).filter((h) => h.command.includes("reins-hook.mjs"));
    assert.equal(ours.length, 1, `${evt}: one Reins hook`);
  }
  const cmds = allCommands(s);
  assert.equal(cmds.filter((c) => c === foreign).length, 2, "both foreign hooks kept");
  assert.ok(cmds.includes(sharedForeign), "a foreign hook sharing a group with ours survives");
  assert.ok(s.hooks.PreToolUse.some((g) => g.matcher === "Bash"), "a foreign matcher group is untouched");

  // Switching to an adapter drops the Claude-only events; uninstall leaves only foreign hooks.
  runInstall(home, ["--agent", "codex", "--me", "asha"]);
  const s2 = settingsFor(home);
  assert.equal(s2.hooks.SessionStart, undefined);
  assert.ok(!allCommands(s2).some((c) => c.includes("reins-hook.mjs")));
  assert.ok(allCommands(s2).some((c) => c.includes("adapters/codex.mjs")));
  execFileSync(process.execPath, [BIN, "uninstall", "--global"], { env: { ...process.env, HOME: home, USERPROFILE: home }, cwd: home, stdio: "ignore" });
  const s3 = settingsFor(home);
  assert.ok(!allCommands(s3).some((c) => c.includes(".reins")));
  assert.deepEqual(allCommands(s3).sort(), [foreign, foreign, sharedForeign].sort());
});
