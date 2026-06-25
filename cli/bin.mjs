#!/usr/bin/env node
/**
 * reins-hook — one-command installer for the Reins capture hook (Claude Code).
 *
 *   npx reins-hook install --url https://reins.yourco.com --me asha
 *   npx reins-hook install --global --me asha --project web-app
 *   npx reins-hook status
 *   npx reins-hook uninstall [--global]
 *
 * It copies the hook to a stable location (~/.reins/reins-hook.mjs) and MERGES
 * the hook config into the chosen settings.json without clobbering other hooks.
 * Dependency-free: only Node built-ins, so `npx` has nothing to install.
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_SRC = join(HERE, "reins-hook.mjs");
const LIB_SRC = join(HERE, "lib");
const ADAPTERS_SRC = join(HERE, "adapters");
const INSTALL_DIR = join(os.homedir(), ".reins");
const INSTALLED_HOOK = join(INSTALL_DIR, "reins-hook.mjs");
const INSTALLED_LIB = join(INSTALL_DIR, "lib");
const INSTALLED_ADAPTERS = join(INSTALL_DIR, "adapters");
const EVENTS = ["UserPromptSubmit", "Stop"];
// Our hook commands all run a file under ~/.reins, so the install path is the
// reliable marker for "this is ours" when merging (covers both the Claude hook
// and every adapter, without clobbering foreign hooks).
const MARKER = INSTALL_DIR;

/**
 * Concrete, tested adapters. Each maps to a file under ~/.reins/adapters and the
 * `source` label its events carry. "claude-code" is special: it is the native
 * hook, not an adapter, and stays the default when --agent is absent.
 */
const AGENTS = {
  "claude-code": { source: "claude-code", file: INSTALLED_HOOK },
  codex: { source: "codex", file: join(INSTALLED_ADAPTERS, "codex.mjs") },
  opencode: { source: "opencode", file: join(INSTALLED_ADAPTERS, "opencode.mjs") },
  aider: { source: "aider", file: join(INSTALLED_ADAPTERS, "aider.mjs") },
  generic: { source: "agent", file: join(INSTALLED_ADAPTERS, "generic.mjs") },
};

const c = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) args[key] = true;
      else { args[key] = next; i++; }
    } else args._.push(a);
  }
  return args;
}

function settingsPath(global) {
  return global
    ? join(os.homedir(), ".claude", "settings.json")
    : resolve(process.cwd(), ".claude", "settings.json");
}

function readJson(path) {
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { console.error(c.red(`! ${path} is not valid JSON — refusing to overwrite. Fix or remove it.`)); process.exit(1); }
}

function buildCommand(opts) {
  const agent = AGENTS[opts.agent || "claude-code"];
  const env = [];
  if (opts.url) env.push(`REINS_URL=${opts.url}`);
  if (opts.me) env.push(`REINS_MEMBER=${opts.me}`);
  if (opts.project) env.push(`REINS_PROJECT=${opts.project}`);
  if (opts.key) env.push(`REINS_KEY=${opts.key}`);
  // The source label rides as an env var so the adapter (and the Claude hook,
  // which already reads REINS_SOURCE) stamps every event with the right origin.
  env.push(`REINS_SOURCE=${opts.source || agent.source}`);
  return `${env.join(" ")} node ${agent.file}`.trim();
}

/** Recursively copy a directory of .mjs sources into the install dir. */
function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, name.name);
    const to = join(dest, name.name);
    if (name.isDirectory()) copyDir(from, to);
    else copyFileSync(from, to);
  }
}

/** Insert/replace our hook entry in one event array, leaving foreign hooks intact. */
function mergeEvent(list, command) {
  const kept = (list || []).filter((group) => {
    const hooks = group?.hooks || [];
    return !hooks.some((h) => typeof h.command === "string" && h.command.includes(MARKER));
  });
  kept.push({ hooks: [{ type: "command", command }] });
  return kept;
}

async function checkServer(url) {
  const base = (url || "http://localhost:4319").replace(/\/$/, "");
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch(`${base}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    if (res.ok) {
      const j = await res.json().catch(() => ({}));
      return { ok: true, llm: j.llm, model: j.model };
    }
    return { ok: false, status: res.status };
  } catch {
    return { ok: false, unreachable: true };
  }
}

async function install(args) {
  const agent = (args.agent && String(args.agent)) || "claude-code";
  if (!AGENTS[agent]) {
    console.error(c.red(`! unknown --agent "${agent}". Known: ${Object.keys(AGENTS).join(", ")}`));
    process.exit(1);
  }
  const opts = {
    url: args.url || "http://localhost:4319",
    me: args.me || args.member,
    project: args.project,
    // --token is the ingest token from the dashboard invite / new-project flow;
    // --key is the legacy single shared secret. Either becomes REINS_KEY, which
    // the hook sends as x-reins-key (accepted as a bearer credential server-side).
    key: args.token || args.key,
    agent,
    source: args.source && String(args.source),
  };
  const global = !!args.global;
  const path = settingsPath(global);

  // 1) copy the hook + shared lib + adapters to a stable location so the
  //    installed command resolves its relative imports (../lib, ./_shared).
  mkdirSync(INSTALL_DIR, { recursive: true });
  copyFileSync(HOOK_SRC, INSTALLED_HOOK);
  copyDir(LIB_SRC, INSTALLED_LIB);
  if (existsSync(ADAPTERS_SRC)) copyDir(ADAPTERS_SRC, INSTALLED_ADAPTERS);

  // 2) merge into settings.json
  mkdirSync(dirname(path), { recursive: true });
  const settings = readJson(path);
  settings.hooks = settings.hooks || {};
  const command = buildCommand(opts);
  for (const evt of EVENTS) settings.hooks[evt] = mergeEvent(settings.hooks[evt], command);
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");

  // 3) report
  console.log(`\n  ${c.green("✓")} Reins hook installed`);
  console.log(`  ${c.dim("agent")}     ${agent} ${c.dim(`(source: ${opts.source || AGENTS[agent].source})`)}`);
  console.log(`  ${c.dim("command")}   ${AGENTS[agent].file}`);
  console.log(`  ${c.dim("settings")}  ${path} ${c.dim(global ? "(global — all repos)" : "(this repo)")}`);
  console.log(`  ${c.dim("events")}    ${EVENTS.join(", ")}`);
  console.log(`  ${c.dim("as")}        ${opts.me || c.yellow("(auto: git email → $USER)")}`);
  console.log(`  ${c.dim("project")}   ${opts.project || c.yellow("(auto: folder name)")}`);
  console.log(`  ${c.dim("server")}    ${opts.url}`);

  const health = await checkServer(opts.url);
  if (health.ok) console.log(`  ${c.green("✓")} server reachable ${c.dim(`(llm: ${health.llm ? health.model : "off"})`)}`);
  else if (health.unreachable) console.log(`  ${c.yellow("!")} couldn't reach ${opts.url} — start the Reins server, or pass the right --url`);
  else console.log(`  ${c.yellow("!")} server returned ${health.status} at ${opts.url}`);

  if (agent === "claude-code") {
    console.log(`\n  ${c.b("Last step:")} in Claude Code run ${c.cyan("/hooks")} to approve the new hook (or restart).`);
  } else {
    // The settings.json entry is the unified record of the wiring; the actual
    // trigger for a non-Claude agent lives in that agent's own config. Tell the
    // truth about where to point it.
    console.log(`\n  ${c.b("Last step:")} point ${agent}'s notify/plugin at the command above. See ${c.cyan("hooks/README.md")} for the exact line.`);
  }
  console.log(`  ${c.dim("Then just work — your prompts and turns flow to the Reins board.")}\n`);
}

function uninstall(args) {
  const global = !!args.global;
  const path = settingsPath(global);
  if (!existsSync(path)) { console.log(c.yellow(`Nothing to do — ${path} doesn't exist.`)); return; }
  const settings = readJson(path);
  let removed = 0;
  for (const evt of EVENTS) {
    const list = settings.hooks?.[evt];
    if (!Array.isArray(list)) continue;
    const before = list.length;
    settings.hooks[evt] = list.filter((g) => !(g?.hooks || []).some((h) => typeof h.command === "string" && h.command.includes(MARKER)));
    removed += before - settings.hooks[evt].length;
    if (settings.hooks[evt].length === 0) delete settings.hooks[evt];
  }
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
  console.log(removed ? c.green(`✓ Removed Reins hook from ${path}`) : c.yellow(`No Reins hook found in ${path}`));
}

async function status(args) {
  for (const [label, global] of [["global", true], ["this repo", false]]) {
    const path = settingsPath(global);
    const settings = readJson(path);
    const cmds = EVENTS.flatMap((e) => (settings.hooks?.[e] || []).flatMap((g) => (g.hooks || []).map((h) => h.command)))
      .filter((cmd) => typeof cmd === "string" && cmd.includes(MARKER));
    if (cmds.length) {
      console.log(`  ${c.green("✓")} installed ${c.dim(`(${label}: ${path})`)}`);
      console.log(`    ${c.dim(cmds[0])}`);
    } else {
      console.log(`  ${c.dim("·")} not installed ${c.dim(`(${label}: ${path})`)}`);
    }
  }
  const url = args.url || "http://localhost:4319";
  const health = await checkServer(url);
  console.log(health.ok
    ? `  ${c.green("✓")} server ${url} ${c.dim(`(llm: ${health.llm ? health.model : "off"})`)}`
    : `  ${c.yellow("!")} server ${url} ${health.unreachable ? "unreachable" : health.status}`);
}

function help() {
  console.log(`
  ${c.b("reins-hook")} — install the Reins capture hook for Claude Code

  ${c.b("Usage")}
    npx reins-hook install [options]
    npx reins-hook status [--url <url>]
    npx reins-hook uninstall [--global]

  ${c.b("install options")}
    --agent <name>     which agent harness (default claude-code)
                       known: ${Object.keys(AGENTS).join(", ")}
    --source <id>      override the source label events carry
    --url <url>        Reins server (default http://localhost:4319)
    --me <name>        who you are (default: git email → $USER)
    --project <id>     project scope (default: folder name)
    --token <token>    ingest token from the dashboard invite / new-project flow
    --key <secret>     legacy single shared ingest secret (alias of --token)
    --global           install for ALL repos (~/.claude/settings.json)
                       (default: just this repo's ./.claude/settings.json)

  ${c.b("Examples")}
    npx reins-hook install --url https://reins.yourco.com --me asha
    npx reins-hook install --global --me asha --project web-app
    npx reins-hook install --agent codex --me asha
    npx reins-hook install --agent generic --source my-bot --me asha
`);
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] || "help";
(async () => {
  if (cmd === "install") await install(args);
  else if (cmd === "uninstall") uninstall(args);
  else if (cmd === "status") await status(args);
  else help();
})();
