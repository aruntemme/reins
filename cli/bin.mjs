#!/usr/bin/env node
/**
 * reins-hook — connect your repo and coding agents to a Reins board.
 *
 *   npx reins-hook                         interactive setup (sign in, pick agents)
 *   npx reins-hook --url <url> --project <id>
 *   npx reins-hook install --agent codex --url <url> --project <id> --token <tok>   (CI)
 *   npx reins-hook status
 *   npx reins-hook uninstall [--all]
 *   npx reins-hook mcp [--url <url> --token <token> --project <id> --member <name>]
 *
 * Commands written into agent configs point at a stable copy under ~/.reins and
 * carry only REINS_SOURCE; the server, token, member and project resolve at
 * runtime from ~/.reins/config.json (mode 0600). Dependency-free: only Node
 * built-ins, so `npx` has nothing to install.
 */
import { realpathSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runMcp } from "./reins-mcp.mjs";
import { createUI } from "./lib/tui.mjs";
import { mainRootOf } from "./lib/git.mjs";
import { runSetup, http, normalizeInputUrl, parseAgentList } from "./lib/setup.mjs";
import {
  loadConfig, rememberSetup, forgetSetup, repoEntry, configPath, normalizeUrl, resolveRuntime, HOSTED_URL,
} from "./lib/config.mjs";
import {
  AGENTS, WIZARD_AGENTS, installAgent, uninstallAgent, agentStatus, installDir, tildify,
  buildCommand, shQuote, maskKey,
} from "./lib/agents.mjs";

export { buildCommand, shQuote, maskKey };

// Flags that never take a value (so `--yes setup` doesn't read "setup" as the value).
const BOOLEAN_FLAGS = new Set(["yes", "no-open", "global", "all", "help", "version"]);

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-y") args.yes = true;
    else if (a === "-h") args.help = true;
    else if (a === "-v") args.version = true;
    else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 2) { args[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (BOOLEAN_FLAGS.has(key) || next === undefined || next.startsWith("--")) args[key] = true;
      else { args[key] = next; i++; }
    } else args._.push(a);
  }
  return args;
}

function git(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}
/** This folder's git toplevel (the worktree), else the folder itself. */
const toplevel = (cwd) => git(["rev-parse", "--show-toplevel"], cwd) || resolve(cwd);
/** The key this folder has in the repos map: the MAIN repo root (so every worktree
 *  shares one entry), else the folder itself. */
const repoKey = (cwd) => {
  const top = git(["rev-parse", "--show-toplevel"], cwd);
  const common = top && git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
  return top ? mainRootOf(common, top) : resolve(cwd);
};

const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

// ---------------------------------------------------------------- install (flags, CI)

async function install(args) {
  const ui = createUI();
  const { c } = ui;
  let agents;
  try {
    const raw = str(args.agent) || str(args.agents) || "claude-code";
    agents = raw.split(",").map((s) => s.trim()).filter(Boolean)
      .flatMap((a) => (a === "generic" ? ["generic"] : parseAgentList(a)));
  } catch (e) {
    console.error(c.red(`! ${e.message}, generic`));
    return 1;
  }
  const cwd = process.cwd();
  const top = git(["rev-parse", "--show-toplevel"], cwd);
  const dir = top || resolve(cwd); // where a repo-scoped Claude install writes (this worktree)
  const key = repoKey(cwd);
  const root = top ? key : null; // in a worktree: the main repo, so all worktrees share one mapping
  const cfg = loadConfig();
  const saved = repoEntry(cfg, cwd);
  const servers = Object.keys(cfg.servers);
  const url = normalizeInputUrl(str(args.url) || "") || saved?.url || servers[servers.length - 1] || HOSTED_URL;
  if (str(args.url) && !normalizeInputUrl(args.url)) { console.error(c.red(`! --url ${args.url} isn't a valid URL`)); return 1; }
  const token = str(args.token) || str(args.key);
  const member = str(args.me) || str(args.member);
  // In a repo the mapping names its project. Outside one (e.g. a --global install
  // from your home folder) it maps every folder below to the server, and each
  // repo keeps its folder name as the project unless --project pins one.
  const project = str(args.project) ||
    (saved && saved.root === key && normalizeUrl(saved.url) === url ? saved.project : undefined) ||
    (root ? basename(root) : undefined);
  const scope = args.global || args.scope === "global" ? "global" : "repo";

  // The connection lives in ~/.reins/config.json, so no command we write holds a token.
  rememberSetup({ server: { url, token, member }, repo: { root: key, url, project } });

  ui.write("");
  let failed = 0;
  for (const id of agents) {
    let r;
    try {
      r = installAgent(id, { cwd, dir, scope, source: str(args.source) });
    } catch (e) {
      ui.err(`${AGENTS[id]?.label || id}: ${e.message}`);
      failed++;
      continue;
    }
    const tools = () => {
      if (r.tools) ui.ok(`${AGENTS[id].label}: Reins tools connected`);
      else if (r.toolsNote) (id === "aider" ? ui.hint : ui.warn)(r.toolsNote);
    };
    if (r.conflict) { ui.warn(`${AGENTS[id].label}: not wired — ${r.conflict}`); tools(); failed++; continue; }
    if (r.manual) {
      ui.ok(`${AGENTS[id].label}: run this from your agent's prompt/stop hook (pipe it a JSON object):`);
      ui.info(c.cyan(r.manual));
      continue;
    }
    for (const w of r.wrote) ui.ok(`${AGENTS[id].label} ${c.dim("→")} ${w.path} ${c.dim(`(${w.note})`)}`);
    for (const n of r.notes || []) ui.warn(n);
    tools();
    if (r.next) ui.hint(id === "claude-code" ? "Last step: in Claude Code run /hooks to approve the new hooks (or restart)." : r.next);
  }
  ui.kv("server", url);
  ui.kv("project", project || c.dim("(each repo's folder name)"));
  ui.kv("as", member || c.dim("(from the server sign-in, else git email → $USER)"));
  ui.kv("config", `${configPath()} ${c.dim(token ? "(token stored here, not in agent settings)" : "")}`);

  const h = await http(url, "/health", { timeoutMs: 2500 });
  if (h.ok && h.json?.ok) ui.ok(`server reachable ${c.dim(`(llm: ${h.json.llm ? h.json.model || "on" : "off"}, sign-in: ${h.json.auth ? "required" : "off"})`)}`);
  else ui.warn(h.unreachable ? `couldn't reach ${url} — start the Reins server, or pass the right --url` : `server returned ${h.status} at ${url}`);
  if (h.json?.auth && !token && !loadConfig().servers[url]?.token) {
    ui.warn(`this server requires sign-in — run ${c.cyan("npx reins-hook")} to sign in, or pass --token`);
  }
  ui.write("");
  return failed ? 1 : 0;
}

// ---------------------------------------------------------------- status

async function status(args) {
  const ui = createUI();
  const { c } = ui;
  const cwd = process.cwd();
  const key = repoKey(cwd);
  const cfg = loadConfig();
  const entry = repoEntry(cfg, cwd);
  const rt = resolveRuntime({ cwd, config: cfg });
  const url = normalizeInputUrl(str(args.url) || "") || rt.url;
  const server = cfg.servers[url] || {};

  ui.banner("Reins status");
  ui.write("");
  const h = await http(url, "/health", { timeoutMs: 2500 });
  ui.kv("server", h.ok && h.json?.ok
    ? `${url} ${c.green("✓")} ${c.dim(`reachable · llm ${h.json.llm ? "on" : "off"} · sign-in ${h.json.auth ? "required" : "off"}`)}`
    : `${url} ${c.yellow("!")} ${h.unreachable ? "unreachable" : `HTTP ${h.status}`}`);
  ui.kv("you", `${rt.member}${server.workspace?.name ? c.dim(` · workspace ${server.workspace.name}`) : ""} ${
    server.token ? c.dim("(signed in)") : process.env.REINS_KEY ? c.dim("(token from REINS_KEY)") : c.dim("(not signed in)")}`);
  ui.kv("repo", entry
    ? `${tildify(entry.root)} → project ${c.b(entry.project || rt.project)}${entry.project ? "" : c.dim(" (folder name)")}${entry.root !== key ? c.dim(" (inherited from a parent folder)") : ""}`
    : `${tildify(key)} ${c.yellow("not set up")} ${c.dim(`— run npx reins-hook (events would go to project "${rt.project}")`)}`);
  ui.write("");
  ui.write(`  ${c.b("agents")}`);
  const o = { cwd, dir: toplevel(cwd) };
  for (const id of WIZARD_AGENTS) {
    const rows = agentStatus(id, o);
    if (!rows.length) { ui.write(`     ${c.dim("·")} ${AGENTS[id].label.padEnd(12)} ${c.dim("not wired")}`); continue; }
    for (const r of rows) {
      const mark = r.warn ? c.yellow("!") : c.green("✓");
      ui.write(`     ${mark} ${AGENTS[id].label.padEnd(12)} ${tildify(r.path)} ${c.dim(`(${r.note})`)}`);
      if (r.command && /REINS_(KEY|URL|PROJECT|MEMBER)=/.test(r.command)) ui.write(`         ${c.dim(maskKey(r.command))}`);
      if (r.warn) ui.write(`         ${c.yellow(r.warn)}`);
    }
  }
  ui.write("");
  ui.hint(`config: ${tildify(configPath())}${existsSync(configPath()) ? "" : " (not created yet)"}`);
  ui.write("");
  return 0;
}

// ---------------------------------------------------------------- uninstall

function uninstall(args) {
  const ui = createUI();
  const { c } = ui;
  const cwd = process.cwd();
  const key = repoKey(cwd);
  const o = { cwd, dir: toplevel(cwd) };
  ui.write("");
  let any = false;
  for (const id of WIZARD_AGENTS) {
    for (const path of uninstallAgent(id, o)) {
      any = true;
      ui.ok(`${AGENTS[id].label}: removed Reins from ${tildify(path)}`);
    }
  }
  const f = forgetSetup({ root: key, credentials: !!args.all });
  if (f.removed) {
    any = true;
    ui.ok(args.all ? `Forgot every saved sign-in and repo in ${tildify(configPath())}` : `Forgot this repo's project mapping in ${tildify(configPath())}`);
  }
  if (!any) ui.info(c.dim("Nothing to remove."));
  if (!args.all) ui.hint(`Saved sign-ins are kept (npx reins-hook uninstall --all forgets them too). Hook files stay in ${tildify(installDir())}.`);
  ui.write("");
  return 0;
}

// ---------------------------------------------------------------- help

function help() {
  const { c } = createUI();
  console.log(`
  ${c.b("reins-hook")} — connect your repo and coding agents to a Reins board

  ${c.b("Usage")}
    npx reins-hook [setup] [options]     interactive setup (the default)
    npx reins-hook install [options]     non-interactive, for CI and scripts
    npx reins-hook status                server, who you are, repo → project, wired agents
    npx reins-hook uninstall [--all]     remove all agent wiring we added
    npx reins-hook mcp [--url <url> --token <ingest token> --project <id> --member <name>]

  ${c.b("setup")} — detects the repo, checks the server, signs you in in the browser
  (no tokens to copy), wires the agents you pick and puts you on the board.
    --url <url>          Reins server (default: this repo's, else last used, else ${HOSTED_URL})
    --project <id>       project this repo reports to (preselects / validates)
    --agents <list>      claude-code,codex,opencode,aider (default: pick from detected)
    --scope repo|global  Claude Code: this repo (.claude/settings.local.json) or all repos
    --no-open            don't open the browser
    --yes, -y            accept defaults; runs without a terminal (all prompts answered)

  ${c.b("install")} — writes the same agent configs without prompts
    --agent <list>       ${Object.keys(AGENTS).join(", ")} (default claude-code)
    --url <url>          Reins server
    --project <id>       project scope (default: repo folder name)
    --token <token>      ingest token (stored in ~/.reins/config.json, mode 0600)
    --me <name>          who you are (default: server sign-in, else git email → $USER)
    --global             Claude Code: all repos (~/.claude/settings.json)
    --source <id>        override the source label events carry

  ${c.b("Where things go")}
    Claude Code  .claude/settings.local.json (this repo) or ~/.claude/settings.json
    Codex CLI    notify in ~/.codex/config.toml
    OpenCode     ~/.config/opencode/plugins/reins.js
    Aider        notifications-command in ~/.aider.conf.yml (no MCP support)
    Reins tools  Claude Code ~/.claude.json · Codex ~/.codex/config.toml · OpenCode ~/.config/opencode/opencode.json
    Sign-in      ~/.reins/config.json (servers + repo → project), read at runtime

  ${c.b("mcp")} — Reins tools for your agent (items, steps, ask a teammate, hand over)
    Setup registers it for Claude Code, Codex and OpenCode (no token in the command: it reads
    ~/.reins/config.json for the folder the agent runs in). Other MCP clients can run
      npx reins-hook mcp
    Flags override the saved connection. Old setups keep working: --ingest-token, or an
    rk_access_… --token, selects the previous tool set.
`);
  return 0;
}

// Only run the CLI when executed, not when imported (tests import the helpers).
const isMain = (() => {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; }
  catch { return false; }
})();

if (isMain) (async () => {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || "setup";
  let code = 0;
  try {
    if (args.help || cmd === "help") code = help();
    else if (args.version) console.log(JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version);
    else if (cmd === "setup") code = await runSetup(args);
    else if (cmd === "install") code = await install(args);
    else if (cmd === "uninstall") code = uninstall(args);
    else if (cmd === "status") code = await status(args);
    else if (cmd === "mcp") {
      // Long-lived stdio server, launched by the agent. stdout is reserved for the
      // protocol, so it must stay silent here.
      const v = (k) => (typeof args[k] === "string" ? args[k] : undefined);
      await runMcp({
        url: v("url"), token: v("token") || v("key"), ingestToken: v("ingest-token") || v("ingest"),
        project: v("project"), member: v("member"),
      });
      return;
    } else {
      console.error(`Unknown command "${cmd}".`);
      code = help() || 1;
    }
  } catch (e) {
    console.error(`\n  ! ${e?.message || e}\n`);
    code = 1;
  }
  process.exitCode = code;
})();
