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
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_SRC = join(HERE, "reins-hook.mjs");
const INSTALL_DIR = join(os.homedir(), ".reins");
const INSTALLED_HOOK = join(INSTALL_DIR, "reins-hook.mjs");
const EVENTS = ["UserPromptSubmit", "Stop"];
const MARKER = "reins-hook.mjs"; // identifies our hook commands when merging

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
  const env = [];
  if (opts.url) env.push(`REINS_URL=${opts.url}`);
  if (opts.me) env.push(`REINS_MEMBER=${opts.me}`);
  if (opts.project) env.push(`REINS_PROJECT=${opts.project}`);
  if (opts.key) env.push(`REINS_KEY=${opts.key}`);
  return `${env.join(" ")}${env.length ? " " : ""}node ${INSTALLED_HOOK}`.trim();
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
  const opts = {
    url: args.url || "http://localhost:4319",
    me: args.me || args.member,
    project: args.project,
    key: args.key,
  };
  const global = !!args.global;
  const path = settingsPath(global);

  // 1) copy the hook to a stable location
  mkdirSync(INSTALL_DIR, { recursive: true });
  copyFileSync(HOOK_SRC, INSTALLED_HOOK);

  // 2) merge into settings.json
  mkdirSync(dirname(path), { recursive: true });
  const settings = readJson(path);
  settings.hooks = settings.hooks || {};
  const command = buildCommand(opts);
  for (const evt of EVENTS) settings.hooks[evt] = mergeEvent(settings.hooks[evt], command);
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");

  // 3) report
  console.log(`\n  ${c.green("✓")} Reins hook installed`);
  console.log(`  ${c.dim("hook")}      ${INSTALLED_HOOK}`);
  console.log(`  ${c.dim("settings")}  ${path} ${c.dim(global ? "(global — all repos)" : "(this repo)")}`);
  console.log(`  ${c.dim("events")}    ${EVENTS.join(", ")}`);
  console.log(`  ${c.dim("as")}        ${opts.me || c.yellow("(auto: git email → $USER)")}`);
  console.log(`  ${c.dim("project")}   ${opts.project || c.yellow("(auto: folder name)")}`);
  console.log(`  ${c.dim("server")}    ${opts.url}`);

  const health = await checkServer(opts.url);
  if (health.ok) console.log(`  ${c.green("✓")} server reachable ${c.dim(`(llm: ${health.llm ? health.model : "off"})`)}`);
  else if (health.unreachable) console.log(`  ${c.yellow("!")} couldn't reach ${opts.url} — start the Reins server, or pass the right --url`);
  else console.log(`  ${c.yellow("!")} server returned ${health.status} at ${opts.url}`);

  console.log(`\n  ${c.b("Last step:")} in Claude Code run ${c.cyan("/hooks")} to approve the new hook (or restart).`);
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
    --url <url>        Reins server (default http://localhost:4319)
    --me <name>        who you are (default: git email → $USER)
    --project <id>     project scope (default: folder name)
    --key <secret>     ingest key, if the server requires one
    --global           install for ALL repos (~/.claude/settings.json)
                       (default: just this repo's ./.claude/settings.json)

  ${c.b("Examples")}
    npx reins-hook install --url https://reins.yourco.com --me asha
    npx reins-hook install --global --me asha --project web-app
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
