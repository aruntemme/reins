/**
 * Agent installers: write each agent's REAL config so its activity reaches Reins.
 *
 *   claude-code  hooks in ~/.claude/settings.json (all repos) or
 *                <repo>/.claude/settings.local.json (this repo; personal, git-ignored)
 *   codex        top-level `notify` in ~/.codex/config.toml ($CODEX_HOME honoured)
 *   opencode     plugin file ~/.config/opencode/plugins/reins.js ($XDG_CONFIG_HOME honoured)
 *   aider        `notifications` + `notifications-command` in ~/.aider.conf.yml
 *
 * Rules every writer follows:
 *   • idempotent — re-running replaces ours in place, never duplicates it;
 *   • never clobbers foreign config — a conflicting setting is left exactly as it
 *     is and the result says what to change by hand;
 *   • reversible — uninstall removes only what we added (recognised by the
 *     ~/.reins install path in our commands, or our "added by reins-hook" tag);
 *   • commands carry no secrets — at most REINS_SOURCE; the connection comes from
 *     ~/.reins/config.json at runtime (lib/config.mjs).
 *
 * Global agent config locations are preferred over repo files: our commands hold
 * a machine-specific absolute path, which would break teammates if committed.
 *
 * Every function takes { home, cwd, dir, env } so tests can point it at temp dirs.
 */
import {
  readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync, unlinkSync, statSync, realpathSync,
} from "node:fs";
import { dirname, join, resolve, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const CLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const TAG = "added by reins-hook";

/** Claude Code hook events we register (edit-tool matcher on Pre/PostToolUse). */
const EDIT_MATCHER = "Edit|Write|MultiEdit|NotebookEdit";
export const CLAUDE_EVENTS = [
  { event: "SessionStart" },
  { event: "UserPromptSubmit" },
  { event: "PreToolUse", matcher: EDIT_MATCHER },
  { event: "PostToolUse", matcher: EDIT_MATCHER },
  { event: "Stop" },
];
const EVENTS = CLAUDE_EVENTS.map((e) => e.event);
// Backstop only (seconds): the hook itself gives up after ≤ 2s.
const HOOK_TIMEOUT_S = 10;

export const AGENTS = {
  "claude-code": { label: "Claude Code", source: "claude-code", bin: "claude", file: "reins-hook.mjs" },
  codex: { label: "Codex CLI", source: "codex", bin: "codex", file: "adapters/codex.mjs" },
  opencode: { label: "OpenCode", source: "opencode", bin: "opencode", file: "adapters/opencode.mjs" },
  aider: { label: "Aider", source: "aider", bin: "aider", file: "adapters/aider.mjs" },
  generic: { label: "Any agent (generic)", source: "agent", bin: null, file: "adapters/generic.mjs" },
};
/** The agents the wizard offers (generic has no config of its own to write). */
export const WIZARD_AGENTS = ["claude-code", "codex", "opencode", "aider"];

// ---------------------------------------------------------------- paths

const homeOf = (o = {}) => o.home || os.homedir();
const envOf = (o = {}) => o.env || process.env;
export const installDir = (o = {}) => join(homeOf(o), ".reins");
/** The install dir as it appears inside our commands (forward slashes). */
const marker = (o) => installDir(o).replace(/\\/g, "/");
/** Absolute, forward-slashed path of an agent's script under ~/.reins. */
export const agentScript = (id, o) => `${marker(o)}/${AGENTS[id].file}`;

export function claudeSettingsPaths(o = {}) {
  const dir = o.dir || o.cwd || process.cwd();
  return {
    global: join(homeOf(o), ".claude", "settings.json"),
    repo: join(dir, ".claude", "settings.local.json"),
    shared: join(dir, ".claude", "settings.json"),
  };
}
export const codexConfigPath = (o = {}) => join(envOf(o).CODEX_HOME || join(homeOf(o), ".codex"), "config.toml");
const xdgConfig = (o = {}) => envOf(o).XDG_CONFIG_HOME || join(homeOf(o), ".config");
export const opencodePluginPath = (o = {}) => join(xdgConfig(o), "opencode", "plugins", "reins.js");
// Older opencode releases (and some docs) used the singular directory.
const opencodeLegacyPluginPath = (o = {}) => join(xdgConfig(o), "opencode", "plugin", "reins.js");
export const aiderConfigPath = (o = {}) => join(homeOf(o), ".aider.conf.yml");

function sameFile(a, b) {
  const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
  return real(a) === real(b);
}

/** Shorten a path under $HOME to ~/… for display. */
export function tildify(p, o = {}) {
  const h = homeOf(o);
  return p === h ? "~" : p.startsWith(h + "/") || p.startsWith(h + "\\") ? `~${p.slice(h.length)}` : p;
}

// ---------------------------------------------------------------- runtime copy

function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, e.name);
    const to = join(dest, e.name);
    if (e.isDirectory()) copyDir(from, to);
    else if (resolve(from) !== resolve(to)) copyFileSync(from, to);
  }
}

/** Copy the hook, the shared lib and the adapters to ~/.reins, where every
 *  command we write points (a stable path that outlives the npx cache). */
export function installRuntime(o = {}) {
  const dest = installDir(o);
  mkdirSync(dest, { recursive: true });
  const hook = join(CLI_ROOT, "reins-hook.mjs");
  if (resolve(hook) !== resolve(join(dest, "reins-hook.mjs"))) copyFileSync(hook, join(dest, "reins-hook.mjs"));
  copyDir(join(CLI_ROOT, "lib"), join(dest, "lib"));
  copyDir(join(CLI_ROOT, "adapters"), join(dest, "adapters"));
  return dest;
}

// ---------------------------------------------------------------- detection

function onPath(bin, env) {
  const dirs = String(env.PATH || "").split(delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? ["", ...String(env.PATHEXT || ".EXE;.CMD;.BAT").split(";")] : [""];
  for (const d of dirs) {
    for (const ext of exts) {
      try { if (statSync(join(d, bin + ext)).isFile()) return true; } catch { /* not here */ }
    }
  }
  return false;
}

/** Which agents look installed: their binary on PATH, or their config dir. */
export function detectAgents(o = {}) {
  const env = envOf(o);
  const dirs = {
    "claude-code": join(homeOf(o), ".claude"),
    codex: dirname(codexConfigPath(o)),
    opencode: join(xdgConfig(o), "opencode"),
    aider: aiderConfigPath(o),
  };
  return WIZARD_AGENTS.map((id) => {
    const bin = onPath(AGENTS[id].bin, env);
    const cfg = existsSync(dirs[id]);
    return {
      id,
      label: AGENTS[id].label,
      detected: bin || cfg,
      how: bin ? `${AGENTS[id].bin} on PATH` : cfg ? tildify(dirs[id], o) : "not found",
    };
  });
}

// ---------------------------------------------------------------- commands

/**
 * POSIX-quote a value for the `VAR=value` prefix. Claude Code hook commands run
 * under bash (shell: "bash" is pinned, including on Windows). Plain values stay
 * unquoted so commands remain readable.
 */
export function shQuote(v) {
  const s = String(v);
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The shell command for an agent: `REINS_SOURCE=<source> node "<~/.reins/…>"`.
 * Only the source label rides in the command; the connection resolves at runtime.
 * The path is quoted and forward-slashed (bash strips Windows backslashes).
 */
export function buildCommand(opts = {}) {
  const id = opts.agent || "claude-code";
  const source = opts.source || AGENTS[id].source;
  return `REINS_SOURCE=${shQuote(source)} node "${agentScript(id, opts)}"`;
}

// ---------------------------------------------------------------- JSON settings (Claude Code)

function readJsonStrict(path) {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return {};
  let v;
  try { v = JSON.parse(raw); }
  catch { throw new Error(`${path} is not valid JSON — refusing to overwrite it. Fix or remove it, then run again.`); }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${path} isn't a JSON object — refusing to overwrite it.`);
  return v;
}
const writeJsonFile = (path, v) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(v, null, 2) + "\n");
};

const isOursIn = (o, sub = "") => (h) => typeof h?.command === "string" && h.command.includes(marker(o) + sub);

/** An event's hook groups without ours. `list` is undefined when nothing remains. */
function withoutOurs(list, isOurs) {
  if (!Array.isArray(list)) return { list, removed: 0 };
  let removed = 0;
  const out = [];
  for (const group of list) {
    const hooks = Array.isArray(group?.hooks) ? group.hooks : [];
    const foreign = hooks.filter((h) => !isOurs(h));
    removed += hooks.length - foreign.length;
    if (foreign.length === hooks.length) out.push(group);
    else if (foreign.length) out.push({ ...group, hooks: foreign });
  }
  return { list: out.length ? out : undefined, removed };
}

/** Remove our hooks (optionally only adapter ones) from a Claude settings file. */
function scrubClaudeFile(path, o, sub = "") {
  if (!existsSync(path)) return 0;
  const settings = readJsonStrict(path);
  if (!settings.hooks || typeof settings.hooks !== "object") return 0;
  let removed = 0;
  for (const evt of Object.keys(settings.hooks)) {
    const r = withoutOurs(settings.hooks[evt], isOursIn(o, sub));
    removed += r.removed;
    if (r.list) settings.hooks[evt] = r.list;
    else delete settings.hooks[evt];
  }
  if (removed) writeJsonFile(path, settings);
  return removed;
}

/** The commands of ours in a Claude settings file (status). */
function ourClaudeCommands(path, o) {
  let settings;
  try { settings = readJsonStrict(path); } catch { return []; }
  return EVENTS.flatMap((e) => (settings.hooks?.[e] || []).flatMap((g) => (g?.hooks || []).map((h) => h?.command)))
    .filter((c) => typeof c === "string" && c.includes(marker(o)));
}

/** 0.1.x registered non-Claude adapters as Claude Code hooks (so Claude Code ran
 *  e.g. the codex adapter on every prompt). Sweep those everywhere we look. */
function scrubLegacyAdapterHooks(o) {
  const p = claudeSettingsPaths(o);
  const out = [];
  for (const path of [p.global, p.repo, p.shared]) {
    try { if (scrubClaudeFile(path, o, "/adapters/")) out.push(path); } catch { /* unreadable: leave it */ }
  }
  return out;
}

function installClaude(o) {
  const scope = o.scope === "global" ? "global" : "repo";
  const paths = claudeSettingsPaths(o);
  const path = paths[scope];
  const settings = readJsonStrict(path);
  if (settings.hooks !== undefined && (typeof settings.hooks !== "object" || Array.isArray(settings.hooks))) {
    return { conflict: `${path} has a "hooks" value that is not an object; fix it, then run again.`, wrote: [] };
  }
  settings.hooks = settings.hooks || {};
  const command = buildCommand({ ...o, agent: "claude-code" });
  const ours = isOursIn(o);
  for (const evt of EVENTS) {
    const spec = CLAUDE_EVENTS.find((w) => w.event === evt);
    const kept = withoutOurs(settings.hooks[evt], ours).list || [];
    // shell: "bash" pins the interpreter so the POSIX `VAR=val node "…"` form runs
    // identically on Windows (Git Bash).
    kept.push({
      ...(spec.matcher ? { matcher: spec.matcher } : {}),
      hooks: [{ type: "command", command, shell: "bash", timeout: HOOK_TIMEOUT_S }],
    });
    settings.hooks[evt] = kept;
  }
  writeJsonFile(path, settings);
  const wrote = [{ path, note: scope === "global" ? "hooks for all repos" : "hooks for this repo (personal, not committed)" }];
  const notes = [];
  // A project install also sweeps a stale copy of ours out of the SHARED
  // settings.json (an absolute path there breaks every teammate who pulls).
  // (Run from the home folder, the "shared" file IS the global one: leave it.)
  if (scope === "repo" && !sameFile(paths.shared, paths.global)) {
    try {
      if (scrubClaudeFile(paths.shared, o)) notes.push(`removed a stale Reins hook from ${paths.shared} — commit that change so teammates stop seeing a missing-path error`);
    } catch { /* invalid JSON in the shared file: not ours to fix */ }
  }
  return { wrote, notes, next: "In Claude Code run /hooks to approve the new hooks (or restart it)." };
}

function uninstallClaude(o) {
  const p = claudeSettingsPaths(o);
  const removed = [];
  for (const path of [p.global, p.repo, p.shared]) {
    try { if (scrubClaudeFile(path, o)) removed.push(path); } catch { /* unreadable */ }
  }
  return removed;
}

function statusClaude(o) {
  const p = claudeSettingsPaths(o);
  const rows = [];
  const places = [["all repos", p.global], ["this repo", p.repo]];
  if (!sameFile(p.shared, p.global)) places.push(["this repo, shared", p.shared]);
  for (const [where, path] of places) {
    const cmds = ourClaudeCommands(path, o).filter((c) => !c.includes("/adapters/"));
    if (cmds.length) rows.push({ path, note: where, command: cmds[0], warn: where.includes("shared") ? "committed file — run setup again to move it to settings.local.json" : undefined });
  }
  return rows;
}

// ---------------------------------------------------------------- Codex (TOML)

/**
 * Locate the first table header and every top-level `notify` statement in a TOML
 * document, tracking strings, comments and multi-line arrays so a `[` inside a
 * value is never mistaken for a header. Returns { header, notify: [{start,end,text}] }
 * with line indexes.
 */
export function scanToml(lines) {
  let depth = 0; // bracket/brace depth of the value being read
  let multi = null; // '"""' or "'''" while inside a multi-line string
  let header = -1;
  const notify = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const atStatement = depth === 0 && !multi;
    if (atStatement && header === -1 && /^\s*\[/.test(line)) header = i;
    if (atStatement && header === -1 && /^\s*(notify|"notify"|'notify')\s*=/.test(line)) current = { start: i };
    // Scan the line's characters.
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (multi) {
        if (line.startsWith(multi, j)) { multi = null; j += 2; }
        else if (multi === '"""' && ch === "\\") j++;
        continue;
      }
      if (ch === "#") break;
      if (line.startsWith('"""', j) || line.startsWith("'''", j)) { multi = line.slice(j, j + 3); j += 2; continue; }
      if (ch === '"') { for (j++; j < line.length && line[j] !== '"'; j++) if (line[j] === "\\") j++; continue; }
      if (ch === "'") { for (j++; j < line.length && line[j] !== "'"; j++); continue; }
      if (atStatement && header === i) continue; // the header's own brackets
      if (ch === "[" || ch === "{") depth++;
      else if ((ch === "]" || ch === "}") && depth > 0) depth--;
    }
    if (current && depth === 0 && !multi) {
      current.end = i;
      current.text = lines.slice(current.start, i + 1).join("\n");
      notify.push(current);
      current = null;
    }
  }
  return { header, notify };
}

const tomlStr = (s) => JSON.stringify(String(s));
export const codexNotifyLine = (o) => `notify = [${tomlStr("node")}, ${tomlStr(agentScript("codex", o))}] # ${TAG}`;
const isOurNotify = (text, o) => text.includes(agentScript("codex", o));

/** Insert/replace our top-level notify in a config.toml text. Pure. */
export function upsertCodexNotify(text, o) {
  const lines = text.split("\n");
  const { header, notify } = scanToml(lines);
  const line = codexNotifyLine(o);
  const ours = notify.filter((n) => isOurNotify(n.text, o));
  const foreign = notify.filter((n) => !isOurNotify(n.text, o));
  if (foreign.length) return { text, conflict: foreign[0].text };
  if (ours.length) {
    // Replace the first of ours in place, drop any extra copies.
    for (const n of [...ours].reverse()) lines.splice(n.start, n.end - n.start + 1, ...(n === ours[0] ? [line] : []));
    return { text: lines.join("\n"), changed: lines.join("\n") !== text };
  }
  if (header !== -1) {
    // Keys after a [table] belong to that table, so ours goes before the first
    // header — and before the comment block that introduces it.
    let at = header;
    while (at > 0 && /^\s*#/.test(lines[at - 1])) at--;
    lines.splice(at, 0, line);
  } else if (lines[lines.length - 1] === "") {
    lines.splice(lines.length - 1, 0, line); // before the final newline ("" → "notify…\n")
  } else {
    lines.push(line, "");
  }
  return { text: lines.join("\n"), changed: true };
}

/** Remove our notify statement(s) from a config.toml text. Pure. */
export function removeCodexNotify(text, o) {
  const lines = text.split("\n");
  const ours = scanToml(lines).notify.filter((n) => isOurNotify(n.text, o));
  for (const n of [...ours].reverse()) lines.splice(n.start, n.end - n.start + 1);
  return { text: lines.join("\n"), removed: ours.length };
}

function installCodex(o) {
  const path = codexConfigPath(o);
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  const r = upsertCodexNotify(before, o);
  if (r.conflict) {
    return {
      wrote: [],
      conflict:
        `${path} already sets a notify program:\n    ${r.conflict.split("\n").join("\n    ")}\n` +
        `  Codex runs only one. To send Codex turns to Reins, change it to:\n    ${codexNotifyLine(o).replace(` # ${TAG}`, "")}\n` +
        `  (or have your notifier also run: node "${agentScript("codex", o)}" "<the JSON argument>")`,
    };
  }
  if (r.changed) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, r.text);
  }
  return { wrote: [{ path, note: "notify → reins (top-level key)" }], next: "Restart Codex to pick up the notify setting." };
}

function uninstallCodex(o) {
  const path = codexConfigPath(o);
  if (!existsSync(path)) return [];
  const r = removeCodexNotify(readFileSync(path, "utf8"), o);
  if (!r.removed) return [];
  writeFileSync(path, r.text);
  return [path];
}

function statusCodex(o) {
  const path = codexConfigPath(o);
  if (!existsSync(path)) return [];
  const { notify } = scanToml(readFileSync(path, "utf8").split("\n"));
  const ours = notify.find((n) => isOurNotify(n.text, o));
  if (ours) return [{ path, note: "notify" }];
  return notify.length ? [{ path, note: "notify", warn: "set to another program — Reins is not wired" , foreign: true }] : [];
}

// ---------------------------------------------------------------- OpenCode (plugin file)

const OPENCODE_MARK = "// reins-hook: managed file";

/** The plugin module opencode loads from ~/.config/opencode/plugins/. It keeps
 *  the text of each message as parts stream in, ships a user prompt as soon as
 *  its text is known, and the assistant's final text when the session goes idle,
 *  each by piping one JSON object to the adapter (which never blocks opencode). */
export function opencodePluginSource(o) {
  return `${OPENCODE_MARK} — written by \`npx reins-hook\`, removed by \`npx reins-hook uninstall\`.
// Sends your opencode prompts and finished turns to your Reins board.
import { spawn } from "node:child_process";

const ADAPTER = ${JSON.stringify(agentScript("opencode", o))};

export const ReinsPlugin = async ({ directory, worktree }) => {
  const cwd = directory || worktree || process.cwd();
  const roles = new Map(); // messageID -> "user" | "assistant"
  const sessions = new Map(); // messageID -> sessionID
  const texts = new Map(); // messageID -> Map(partID -> text)
  const lastAssistant = new Map(); // sessionID -> messageID
  const sent = new Set(); // user messageIDs already shipped

  const textOf = (id) => [...(texts.get(id)?.values() ?? [])].join("\\n").trim();
  const ship = (type, role, text, sessionID) => {
    if (!text) return;
    try {
      const child = spawn("node", [ADAPTER], {
        stdio: ["pipe", "ignore", "ignore"],
        env: { ...process.env, REINS_SOURCE: "opencode" },
        windowsHide: true,
      });
      child.on("error", () => {});
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify({ type, properties: { role, text, sessionID }, cwd }));
      child.unref();
    } catch {}
  };
  const maybeIntent = (id) => {
    if (roles.get(id) !== "user" || sent.has(id)) return;
    const text = textOf(id);
    if (!text) return;
    if (sent.size > 1000) sent.clear();
    sent.add(id);
    ship("message.sent", "user", text, sessions.get(id));
  };

  return {
    event: async ({ event }) => {
      const p = (event && event.properties) || {};
      if (event?.type === "message.updated" && p.info) {
        roles.set(p.info.id, p.info.role);
        sessions.set(p.info.id, p.info.sessionID);
        if (p.info.role === "assistant") lastAssistant.set(p.info.sessionID, p.info.id);
        maybeIntent(p.info.id);
      } else if (event?.type === "message.part.updated" && p.part?.type === "text" && !p.part.synthetic && !p.part.ignored) {
        if (!texts.has(p.part.messageID)) texts.set(p.part.messageID, new Map());
        texts.get(p.part.messageID).set(p.part.id, p.part.text || "");
        sessions.set(p.part.messageID, p.part.sessionID);
        maybeIntent(p.part.messageID);
      } else if (event?.type === "session.idle" && p.sessionID) {
        const id = lastAssistant.get(p.sessionID);
        if (id) ship("session.idle", "assistant", textOf(id), p.sessionID);
        lastAssistant.delete(p.sessionID);
        for (const [mid, sid] of sessions) {
          if (sid === p.sessionID) { sessions.delete(mid); roles.delete(mid); texts.delete(mid); }
        }
      }
    },
  };
};
`;
}

const isOurPlugin = (path) => {
  try { return readFileSync(path, "utf8").startsWith(OPENCODE_MARK); } catch { return false; }
};

function installOpencode(o) {
  const path = opencodePluginPath(o);
  if (existsSync(path) && !isOurPlugin(path)) {
    return {
      wrote: [],
      conflict: `${path} exists and isn't ours — left as is. Rename it, or save the Reins plugin under another name in ${dirname(path)}.`,
    };
  }
  const src = opencodePluginSource(o);
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path) || readFileSync(path, "utf8") !== src) writeFileSync(path, src);
  // A copy of ours in the legacy singular dir would load twice.
  const legacy = opencodeLegacyPluginPath(o);
  if (isOurPlugin(legacy)) unlinkSync(legacy);
  return { wrote: [{ path, note: "plugin (global)" }], next: "Restart opencode to load the plugin." };
}

function uninstallOpencode(o) {
  const out = [];
  for (const path of [opencodePluginPath(o), opencodeLegacyPluginPath(o)]) {
    if (isOurPlugin(path)) { unlinkSync(path); out.push(path); }
  }
  return out;
}

function statusOpencode(o) {
  const path = opencodePluginPath(o);
  if (isOurPlugin(path)) return [{ path, note: "plugin" }];
  return existsSync(path) ? [{ path, note: "plugin", warn: "a different reins.js is there — Reins is not wired", foreign: true }] : [];
}

// ---------------------------------------------------------------- Aider (YAML)

const AIDER_KEY = /^(notifications(?:[-_]command)?)\s*:(.*)$/;
const yamlSq = (s) => `'${String(s).replace(/'/g, "''")}'`;
export const aiderCommand = (o) => `node "${agentScript("aider", o)}"`;
const aiderLines = (o) => ({
  notifications: `notifications: true  # ${TAG}`,
  command: `notifications-command: ${yamlSq(aiderCommand(o))}  # ${TAG}`,
});
const isOurAiderLine = (line) => AIDER_KEY.test(line) && line.trimEnd().endsWith(`# ${TAG}`);

/** Strip a trailing ` # comment` from a plain YAML scalar. */
const yamlValue = (raw) => raw.replace(/\s+#.*$/, "").trim().replace(/^['"]|['"]$/g, "");

/** Insert/replace our notification keys in a ~/.aider.conf.yml text. Pure. */
export function upsertAider(text, o) {
  const kept = text.split("\n").filter((l) => !isOurAiderLine(l));
  const want = aiderLines(o);
  let foreignNotif = null;
  let foreignCmd = null;
  for (const l of kept) {
    const m = l.match(AIDER_KEY);
    if (!m) continue;
    if (m[1] === "notifications") foreignNotif = { line: l, value: yamlValue(m[2]) };
    else foreignCmd = l;
  }
  const truthy = (v) => /^(true|yes|on)$/i.test(v);
  if (foreignCmd || (foreignNotif && !truthy(foreignNotif.value))) {
    const changes = [];
    if (foreignNotif && !truthy(foreignNotif.value)) changes.push(`${foreignNotif.line.trim()}  →  notifications: true`);
    if (foreignCmd) changes.push(`${foreignCmd.trim()}  →  notifications-command: ${yamlSq(aiderCommand(o))}`);
    return { text, conflict: changes };
  }
  const add = [...(foreignNotif ? [] : [want.notifications]), want.command];
  // Append before the final newline ("" → "notifications…\n").
  if (kept[kept.length - 1] === "") kept.splice(kept.length - 1, 0, ...add);
  else kept.push(...add, "");
  const out = kept.join("\n");
  return { text: out, changed: out !== text };
}

/** Remove our notification keys from a ~/.aider.conf.yml text. Pure. */
export function removeAider(text) {
  const lines = text.split("\n");
  const kept = lines.filter((l) => !isOurAiderLine(l));
  return { text: kept.join("\n"), removed: lines.length - kept.length };
}

function installAider(o) {
  const path = aiderConfigPath(o);
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  const r = upsertAider(before, o);
  if (r.conflict) {
    return {
      wrote: [],
      conflict: `${path} already configures aider notifications — left as is. To send aider turns to Reins, change:\n    ${r.conflict.join("\n    ")}`,
    };
  }
  if (r.changed) writeFileSync(path, r.text);
  return { wrote: [{ path, note: "notifications-command → reins" }], next: "Aider picks it up the next time it starts." };
}

function uninstallAider(o) {
  const path = aiderConfigPath(o);
  if (!existsSync(path)) return [];
  const r = removeAider(readFileSync(path, "utf8"));
  if (!r.removed) return [];
  writeFileSync(path, r.text);
  return [path];
}

function statusAider(o) {
  const path = aiderConfigPath(o);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n");
  if (lines.some((l) => isOurAiderLine(l) && l.startsWith("notifications-command"))) return [{ path, note: "notifications-command" }];
  return lines.some((l) => /^notifications[-_]command\s*:/.test(l))
    ? [{ path, note: "notifications-command", warn: "set to another command — Reins is not wired", foreign: true }]
    : [];
}

// ---------------------------------------------------------------- public API

/**
 * Wire one agent. Returns { id, wrote: [{path, note}], notes: [], conflict?, next? }.
 * Copies the runtime to ~/.reins first (every command points there).
 * Options: { home, cwd, dir (repo root for a repo-scoped Claude install), scope, source, env }.
 */
export function installAgent(id, o = {}) {
  if (!AGENTS[id]) throw new Error(`unknown agent "${id}". Known: ${Object.keys(AGENTS).join(", ")}`);
  installRuntime(o);
  const fns = { "claude-code": installClaude, codex: installCodex, opencode: installOpencode, aider: installAider };
  if (id === "generic") {
    return { id, wrote: [], notes: [], manual: buildCommand({ ...o, agent: "generic" }) };
  }
  const r = fns[id](o);
  const notes = [...(r.notes || [])];
  if (id !== "claude-code") {
    const swept = scrubLegacyAdapterHooks(o);
    for (const p of swept) notes.push(`removed an old Reins adapter hook from ${p} (Claude Code no longer runs other agents' adapters)`);
  }
  return { id, wrote: r.wrote || [], notes, conflict: r.conflict, next: r.next };
}

/** Remove one agent's wiring. Returns the files changed. */
export function uninstallAgent(id, o = {}) {
  const fns = { "claude-code": uninstallClaude, codex: uninstallCodex, opencode: uninstallOpencode, aider: uninstallAider };
  return fns[id] ? fns[id](o) : [];
}

/** Where an agent is wired: [{path, note, command?, warn?, foreign?}] (empty = not wired). */
export function agentStatus(id, o = {}) {
  const fns = { "claude-code": statusClaude, codex: statusCodex, opencode: statusOpencode, aider: statusAider };
  try { return fns[id] ? fns[id](o) : []; } catch { return []; }
}

/** Hide an ingest token in a displayed command (legacy installs embedded REINS_KEY). */
export function maskKey(cmd) {
  return cmd.replace(/(REINS_KEY=)('[^']*'|\S+)/, (_m, k, v) => {
    const raw = v.startsWith("'") ? v.slice(1, -1) : v;
    return `${k}${raw.slice(0, Math.min(12, Math.floor(raw.length / 2)))}…`;
  });
}
