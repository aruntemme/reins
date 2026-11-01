/**
 * The first-run setup wizard: `npx reins-hook` (or `npx reins-hook setup`).
 *
 *   1 Repository   git root, repo name, branch, git email
 *   2 Server       --url, else this repo's saved server, else the last one used,
 *                  else the hosted Reins; GET /health
 *   3 Sign in      device login in the browser (POST /api/cli/login + /api/cli/poll),
 *                  or reuse a saved credential that still works; when the server
 *                  runs without accounts, pick a project from GET /api/projects
 *   4 Agents       detected agents pre-ticked; Claude Code scope (this repo / all repos)
 *   5 Configure    save ~/.reins/config.json (0600), write each agent's real config,
 *                  POST /api/hook/hello per agent so the board shows you
 *   → summary + board link
 *
 * Headless: with `interactive: false` (no TTY + --yes) every prompt takes its
 * default, and flags fill the answers (--url, --project, --agents, --scope,
 * --no-open), so tests and power users run exactly this code path.
 */
import { execFileSync, spawn } from "node:child_process";
import { basename, join, resolve } from "node:path";
import os from "node:os";
import { createUI, createPrompter, CancelError } from "./tui.mjs";
import { loadConfig, rememberSetup, normalizeUrl, gitEmail, HOSTED_URL } from "./config.mjs";
import { AGENTS, WIZARD_AGENTS, detectAgents, installAgent, tildify } from "./agents.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function git(args, cwd) {
  try {
    const out = execFileSync("git", args, {
      cwd, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** JSON over HTTP with a timeout. Never throws. */
export async function http(base, path, { method = "GET", body, key, timeoutMs = 8000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(key ? { "x-reins-key": key } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    return { ok: res.ok, status: res.status, json };
  } catch (e) {
    const why = e?.name === "AbortError" ? "timed out" : e?.cause?.code || e?.message || "unreachable";
    return { ok: false, status: 0, unreachable: true, error: why };
  } finally {
    clearTimeout(timer);
  }
}

/** "reins.acme.dev/" → "https://reins.acme.dev"; "localhost:4319" → "http://localhost:4319". */
export function normalizeInputUrl(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = (/^(localhost|127\.|\[::1\]|0\.0\.0\.0)/i.test(s) ? "http://" : "https://") + s;
  try {
    const u = new URL(s);
    return normalizeUrl(`${u.protocol}//${u.host}${u.pathname}`);
  } catch {
    return "";
  }
}

const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);

/** Open a URL in the default browser. Best effort; returns false if it can't. */
export function openBrowser(url) {
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    const [cmd, argv] =
      process.platform === "darwin" ? ["open", [url]]
        // `start ""` — the empty first argument is the window title (Node quotes it as "").
        : process.platform === "win32" ? ["cmd", ["/c", "start", "", url.replace(/&/g, "^&")]]
          : ["xdg-open", [url]];
    const child = spawn(cmd, argv, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

const AGENT_ALIASES = { claude: "claude-code", "claude-code": "claude-code", claudecode: "claude-code", codex: "codex", opencode: "opencode", aider: "aider" };

/** "claude,codex" → ["claude-code", "codex"]; throws on an unknown name. */
export function parseAgentList(value) {
  const out = [];
  for (const raw of String(value).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    const id = AGENT_ALIASES[raw];
    if (!id) throw new Error(`unknown agent "${raw}". Known: ${WIZARD_AGENTS.join(", ")}`);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Run the wizard. Returns a process exit code (0 ok, 1 failed, 130 cancelled).
 * deps: { input, output, env, home, cwd, interactive, open }
 */
export async function runSetup(args, deps = {}) {
  const input = deps.input || process.stdin;
  const output = deps.output || process.stdout;
  const env = deps.env || process.env;
  const home = deps.home || os.homedir();
  const cwd = resolve(deps.cwd || process.cwd());
  const interactive = deps.interactive ?? !!(input.isTTY && output.isTTY && !args.yes);
  const open = deps.open || openBrowser;
  const ui = createUI({ output, env });
  const { c } = ui;

  if (!interactive && !args.yes) {
    ui.write("");
    ui.write(`  ${c.b("npx reins-hook")} is an interactive setup and needs a terminal.`);
    ui.write("");
    ui.write(`  For scripts and CI, use the flag-based installer:`);
    ui.write(`    ${c.cyan("npx reins-hook install --agent claude-code --url <url> --project <id> --token <ingest token>")}`);
    ui.write(`  or run this setup headless, accepting defaults for anything not given:`);
    ui.write(`    ${c.cyan("npx reins-hook setup --yes --url <url> --project <id> --agents claude-code,codex --no-open")}`);
    ui.write("");
    return 1;
  }

  const p = createPrompter({ interactive, input, output, env });
  try {
    return await wizard({ args, p, ui, c, env, home, cwd, open, interactive });
  } catch (e) {
    if (e instanceof CancelError) {
      ui.write("");
      ui.write(`  ${c.yellow("!")} Setup cancelled.`);
      ui.write("");
      return 130;
    }
    throw e;
  }
}

async function wizard({ args, p, ui, c, env, home, cwd, open, interactive }) {
  const cfgFile = join(home, ".reins", "config.json");
  const cfg = loadConfig(cfgFile);
  const noOpen = !!args["no-open"] || args.open === false;
  ui.banner("Reins", "connect this repo and your coding agents");

  // ---------------------------------------------------------------- 1 Repository
  ui.step(1, "Repository");
  const root = git(["rev-parse", "--show-toplevel"], cwd);
  let key = root;
  if (root) {
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], root);
    ui.ok(`${c.b(basename(root))}${branch && branch !== "HEAD" ? c.dim(` on ${branch}`) : ""}  ${c.dim(tildify(root, { home }))}`);
  } else {
    ui.warn(`Not inside a git repository ${c.dim(`(${tildify(cwd, { home })})`)}`);
    ui.hint("Reins maps a repo to a project; run this from your repo's folder for the best results.");
    const go = await p.confirm({ message: "Set up this folder anyway?", initial: true });
    if (!go) return 1;
    key = cwd;
  }
  const repoName = basename(key);
  const email = gitEmail(key);
  const displayName = git(["config", "user.name"], key) || undefined;
  if (email) ui.hint(`git identity: ${email}`);
  const repoCfg = cfg.repos[key] || null;

  // ---------------------------------------------------------------- 2 Server
  ui.step(2, "Server");
  if (args.url === true) { ui.err("--url needs a value"); return 1; }
  const serverKeys = Object.keys(cfg.servers);
  let url = normalizeInputUrl(args.url || "") ||
    repoCfg?.url || serverKeys[serverKeys.length - 1] || HOSTED_URL;
  if (args.url && !normalizeInputUrl(args.url)) { ui.err(`--url ${args.url} isn't a valid URL`); return 1; }
  if (!args.url && interactive) {
    url = await p.text({
      message: "Reins server",
      initial: url,
      validate: (v) => (normalizeInputUrl(v) ? null : "Enter a URL like https://reins.yourco.com"),
    }).then(normalizeInputUrl);
  }
  let health;
  for (;;) {
    const spin = p.spinner(`Checking ${url}`);
    const r = await http(url, "/health", { timeoutMs: 6000 });
    spin.stop();
    if (r.ok && r.json && r.json.ok) { health = r.json; break; }
    const why = r.unreachable ? `couldn't reach it (${r.error})`
      : r.json && r.json.ok === false ? `it answered but isn't healthy${r.json.error ? `: ${r.json.error}` : ""}`
        : r.ok ? "it answered, but not like a Reins server" : `it answered HTTP ${r.status}`;
    ui.err(`${url} — ${why}`);
    if (!interactive) return 1;
    const next = await p.select({
      message: "What now?",
      choices: [
        { label: "Try again", value: "retry" },
        { label: "Use a different URL", value: "edit" },
        { label: "Quit", value: "quit" },
      ],
    });
    if (next === "quit") return 1;
    if (next === "edit") {
      url = normalizeInputUrl(await p.text({
        message: "Reins server",
        initial: url,
        validate: (v) => (normalizeInputUrl(v) ? null : "Enter a URL like https://reins.yourco.com"),
      }));
    }
  }
  ui.ok(`${c.b(url)}  ${c.dim(`AI summaries ${health.llm ? `on${health.model ? ` (${health.model})` : ""}` : "off"} · sign-in ${health.auth ? "required" : "off"}`)}`);

  // ---------------------------------------------------------------- 3 Sign in / project
  ui.step(3, health.auth ? "Sign in" : "Project");
  let creds = null; // { token?, member, workspace?, project: {id, name} }
  const flagProject = args.project && args.project !== true ? String(args.project) : null;
  if (health.auth) {
    const saved = cfg.servers[url];
    const knownProject = flagProject || (repoCfg && normalizeUrl(repoCfg.url) === url ? repoCfg.project : null);
    if (saved?.token && knownProject) {
      const member = saved.member || email || os.userInfo().username;
      const r = await http(url, "/api/hook/hello", {
        method: "POST", key: saved.token, body: { project: knownProject, member, ...(displayName ? { displayName } : {}) },
      });
      if (r.ok) {
        ui.ok(`Already signed in as ${c.b(member)}${saved.workspace?.name ? c.dim(` · workspace ${saved.workspace.name}`) : ""}`);
        if (await p.confirm({ message: "Use this sign-in?", initial: true })) {
          creds = { token: saved.token, member, workspace: saved.workspace, project: { id: knownProject, name: r.json?.project?.name || knownProject } };
        }
      } else if (r.status === 401 || r.status === 403) {
        ui.warn(`Your saved sign-in doesn't work for ${c.b(knownProject)} any more — let's sign in again.`);
      }
    }
    if (!creds) {
      const login = await deviceLogin({ url, repoName, project: flagProject, ui, p, c, open, noOpen });
      if (login.authOff) health.auth = false;
      else if (!login.approved) return 1;
      else {
        creds = { token: login.token, member: login.member, workspace: login.workspace, project: login.project };
        ui.ok(`Signed in as ${c.b(login.member)}${login.workspace?.name ? c.dim(` · workspace ${login.workspace.name}`) : ""}`);
      }
    }
    if (creds && flagProject && creds.project.id !== flagProject) {
      ui.warn(`You approved ${c.b(creds.project.id)} in the browser, but --project said ${c.b(flagProject)}.`);
      const pick = await p.select({
        message: "Which project should this repo report to?",
        choices: [
          { label: creds.project.name || creds.project.id, hint: `${creds.project.id} · approved in the browser`, value: creds.project.id },
          { label: flagProject, hint: "from --project", value: flagProject },
        ],
      });
      if (pick !== creds.project.id) {
        const r = await http(url, "/api/hook/hello", { method: "POST", key: creds.token, body: { project: pick, member: creds.member } });
        if (!r.ok) {
          ui.err(`Can't use ${pick}: ${r.json?.error || `HTTP ${r.status}`}. Keeping ${creds.project.id}.`);
        } else creds.project = { id: pick, name: r.json?.project?.name || pick };
      }
    }
  }
  if (!health.auth) {
    const project = await pickOpenProject({ url, ui, p, c, flagProject, saved: repoCfg && normalizeUrl(repoCfg.url) === url ? repoCfg.project : null, repoName });
    const member = (args.me && args.me !== true ? String(args.me) : null) || cfg.servers[url]?.member || email || os.userInfo().username;
    creds = { member, project, memberOverride: args.me && args.me !== true ? String(args.me) : undefined };
  }
  ui.ok(`Project ${c.b(creds.project.name || creds.project.id)}${creds.project.name && creds.project.name !== creds.project.id ? c.dim(` (${creds.project.id})`) : ""}`);

  // ---------------------------------------------------------------- 4 Agents
  ui.step(4, "Agents");
  const detected = detectAgents({ home, env });
  let agents;
  if (args.agents || args.agent) {
    try { agents = parseAgentList(args.agents || args.agent); }
    catch (e) { ui.err(e.message); return 1; }
    for (const id of agents) ui.ok(`${AGENTS[id].label} ${c.dim(detected.find((d) => d.id === id)?.detected ? "" : "(not detected — wiring it anyway)")}`);
  } else {
    agents = await p.multiselect({
      message: "Which agents should send activity to Reins?",
      choices: detected.map((d) => ({ label: d.label, value: d.id, checked: d.detected, hint: d.detected ? d.how : "not found" })),
    });
    if (!interactive) for (const id of agents) ui.ok(AGENTS[id].label);
  }
  if (!agents.length) {
    if (!interactive) {
      ui.err("No agents detected. Pass --agents claude-code,codex,opencode,aider (any of them).");
      return 1;
    }
    ui.warn("No agents selected — nothing will be captured until you run setup again.");
    if (!(await p.confirm({ message: "Continue without wiring an agent?", initial: false }))) return 1;
  }
  let scope = "repo";
  if (agents.includes("claude-code")) {
    if (args.scope === "global" || args.global) scope = "global";
    else if (args.scope && args.scope !== "repo") { ui.err(`--scope must be "repo" or "global"`); return 1; }
    else if (!args.scope && interactive) {
      scope = await p.select({
        message: "Claude Code: capture in which repos?",
        choices: [
          { label: "This repo", hint: ".claude/settings.local.json (personal, git-ignored)", value: "repo" },
          { label: "All repos", hint: "~/.claude/settings.json", value: "global" },
        ],
      });
    }
  }

  // ---------------------------------------------------------------- 5 Configure
  ui.step(5, "Configure");
  rememberSetup({
    server: { url, token: creds.token, member: creds.token ? creds.member : creds.memberOverride, workspace: creds.workspace },
    repo: { root: key, url, project: creds.project.id },
  }, cfgFile);
  ui.ok(`${tildify(cfgFile, { home })}  ${c.dim("(your sign-in and this repo → project; only you can read it)")}`);
  const wired = [];
  const nexts = [];
  let problems = 0;
  for (const id of agents) {
    let r;
    try {
      r = installAgent(id, { home, cwd: key, dir: key, scope, env });
    } catch (e) {
      ui.err(`${AGENTS[id].label}: ${e.message}`);
      problems++;
      continue;
    }
    if (r.conflict) {
      ui.warn(`${AGENTS[id].label}: not wired — ${r.conflict}`);
      problems++;
      continue;
    }
    for (const w of r.wrote) ui.ok(`${AGENTS[id].label} ${c.dim("→")} ${tildify(w.path, { home })} ${c.dim(`(${w.note})`)}`);
    for (const n of r.notes || []) ui.hint(n);
    wired.push({ id, wrote: r.wrote });
    if (r.next) nexts.push(id === "claude-code" ? "Claude Code: run /hooks to approve (or restart)." : `${AGENTS[id].label}: ${r.next}`);
  }

  // Say hello per agent so the board (and the web connect page) sees you now.
  const sources = wired.length ? wired.map((w) => AGENTS[w.id].source) : [undefined];
  let greeted = 0;
  let helloError = null;
  for (const source of sources) {
    const r = await http(url, "/api/hook/hello", {
      method: "POST",
      key: creds.token,
      body: { project: creds.project.id, member: creds.member, ...(displayName ? { displayName } : {}), ...(source ? { source } : {}) },
    });
    if (r.ok) greeted++;
    else helloError = r.unreachable ? r.error : r.json?.error || `HTTP ${r.status}`;
  }
  if (greeted === sources.length) ui.ok(`The board can see you ${c.dim(`(${wired.length ? wired.map((w) => w.id).join(", ") : "no agents yet"})`)}`);
  else ui.warn(`Couldn't say hello to the board: ${helloError}`);

  // ---------------------------------------------------------------- Summary
  const board = `${url}/project/${encodeURIComponent(creds.project.id)}`;
  ui.write("");
  ui.write(`  ${problems ? c.yellow("!") : c.green("✓")} ${c.b(problems ? "Reins is set up, with notes above" : "Reins is set up")}`);
  ui.kv("you", `${creds.member}${creds.workspace?.name ? c.dim(` · ${creds.workspace.name}`) : ""}`);
  ui.kv("project", creds.project.id);
  ui.kv("repo", tildify(key, { home }));
  ui.kv("agents", wired.length ? wired.map((w) => AGENTS[w.id].label).join(", ") : c.dim("none"));
  ui.write("");
  ui.write(`  Open the board: ${c.cyan(board)}`);
  for (const n of nexts) ui.write(`  ${n.startsWith("Claude Code") ? c.b(n) : n}`);
  ui.write("");
  if (interactive && !noOpen && (await p.confirm({ message: "Open the board now?", initial: true }))) open(board);
  return problems ? 1 : 0;
}

/** Device login: show the code, open the browser, poll until approved/denied/expired. */
async function deviceLogin({ url, repoName, project, ui, p, c, open, noOpen }) {
  for (;;) {
    const start = await http(url, "/api/cli/login", {
      method: "POST",
      body: {
        host: os.hostname().slice(0, 120),
        ...(repoName ? { repo: repoName.slice(0, 200) } : {}),
        // So the approve page preselects the project this command was pointed at.
        ...(project ? { project: project.slice(0, 120) } : {}),
      },
    });
    if (start.status === 400 && /auth is off/i.test(String(start.json?.error || ""))) return { authOff: true };
    if (!start.ok || !start.json?.deviceCode) {
      ui.err(start.unreachable ? `Couldn't reach ${url} (${start.error}).`
        : start.status === 429 ? "Too many sign-ins started from this network — wait a few minutes."
          : `Couldn't start sign-in: ${start.json?.error || `HTTP ${start.status}`}`);
      if (p.interactive && (await p.confirm({ message: "Try again?", initial: true }))) continue;
      return { failed: true };
    }
    const { deviceCode, userCode, verifyPath, expiresIn = 600, interval = 2 } = start.json;
    const verifyUrl = `${url}${verifyPath || `/cli?code=${encodeURIComponent(userCode)}`}`;
    ui.write("");
    ui.info(`Your code   ${c.b(c.inverse(`  ${String(userCode).split("").join(" ")}  `))}`);
    ui.info(`Approve at  ${c.cyan(verifyUrl)}`);
    if (!noOpen && open(verifyUrl)) ui.hint("Opened your browser. Check that it shows the same code, then approve.");
    else ui.hint("Open the link in your browser, check that it shows the same code, then approve.");
    ui.write("");

    const r = await poll({ url, deviceCode, interval, expiresIn, p });
    if (r.approved) return r;
    ui.err(r.denied ? "The sign-in was denied in the browser."
      : r.lost ? `Lost contact with ${url} while waiting.`
        : "The code expired before it was approved.");
    if (p.interactive && (await p.confirm({ message: "Start a new sign-in?", initial: true }))) continue;
    return { failed: true };
  }
}

async function poll({ url, deviceCode, interval, expiresIn, p }) {
  let wait = Math.max(0, Number(interval) || 0) * 1000;
  const deadline = Date.now() + Math.max(1, Number(expiresIn) || 600) * 1000;
  const left = () => {
    const s = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const spin = p.spinner(`Waiting for approval in your browser… (code expires in ${left()})`);
  let failures = 0;
  try {
    while (Date.now() < deadline) {
      await sleep(wait);
      spin.update(`Waiting for approval in your browser… (code expires in ${left()})`);
      const r = await http(url, "/api/cli/poll", { method: "POST", body: { deviceCode }, timeoutMs: 10000 });
      const st = r.json?.status;
      if (r.status === 429 || st === "slow_down") { wait += 1000; continue; }
      if (r.unreachable || r.status >= 500) {
        if (++failures >= 5) return { lost: true };
        continue;
      }
      failures = 0;
      if (st === "approved" && r.json.token) {
        return { approved: true, token: r.json.token, member: r.json.member, project: r.json.project, workspace: r.json.workspace };
      }
      if (st === "denied") return { denied: true };
      if (r.status === 410 || st === "expired") return { expired: true };
    }
    return { expired: true };
  } finally {
    spin.stop();
  }
}

/** Auth-off servers: choose a project from GET /api/projects, or name a new one. */
async function pickOpenProject({ url, ui, p, c, flagProject, saved, repoName }) {
  const r = await http(url, "/api/projects");
  const list = (Array.isArray(r.json) ? r.json : Array.isArray(r.json?.projects) ? r.json.projects : [])
    .filter((x) => x && typeof x.id === "string")
    .map((x) => ({ id: x.id, name: x.name || x.id }));
  const suggestion = flagProject || saved || slug(repoName) || "default";
  if (flagProject) {
    const hit = list.find((x) => x.id === flagProject);
    if (!hit) ui.hint(`${flagProject} is new — it appears on the board with your first activity.`);
    return hit || { id: flagProject, name: flagProject };
  }
  if (!p.interactive) {
    return list.find((x) => x.id === suggestion) || { id: suggestion, name: suggestion };
  }
  const NEW = "\u0000new";
  const choices = [
    ...list.map((x) => ({ label: x.name, hint: x.name !== x.id ? x.id : undefined, value: x.id })),
    { label: c.dim("+ New project…"), value: NEW },
  ];
  const initial = Math.max(0, choices.findIndex((ch) => ch.value === suggestion));
  const pick = list.length ? await p.select({ message: "Which project is this repo part of?", choices, initial }) : NEW;
  if (pick !== NEW) return list.find((x) => x.id === pick);
  const id = await p.text({
    message: "New project id",
    initial: suggestion,
    validate: (v) => (/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(v) ? null : "Letters, digits, dots, dashes and underscores only"),
  });
  return { id, name: id };
}
