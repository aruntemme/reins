# Reins capture hook and agent adapters

## Set up (one command)

In your repo:

```bash
npx reins-hook --url https://reins.yourco.com --project <id>
```

The wizard detects the repo, checks the server, signs you in through the browser
(device login: you approve `<url>/cli?code=XXXX-XXXX` while signed in — nobody copies
tokens), shows the coding agents it found, writes each one's real config, and says hello
so the board shows you. In Claude Code, run `/hooks` once to approve (or restart). Run inside a git
worktree, it keys the mapping by the main repo, so all its worktrees report to the same project.

> Running from this repo before publishing to npm? Use `node cli/bin.mjs …`.
> The CLI source is in [`../cli`](../cli).

Other commands: `npx reins-hook status`, `npx reins-hook uninstall [--all]`, and the
non-interactive `npx reins-hook install --agent <a>[,<b>] --url <url> --project <id> --token <tok>`
for CI.

### Where the connection lives

`~/.reins/config.json` (mode `0600`):

```json
{
  "version": 1,
  "servers": { "https://reins.acme.dev": { "token": "rk_…", "member": "asha@acme.dev", "workspace": { "id": "…", "name": "acme" } } },
  "repos":   { "/abs/path/to/git/root": { "url": "https://reins.acme.dev", "project": "checkout-v2" } }
}
```

At runtime the hook and every adapter resolve, field by field: explicit env
(`REINS_URL`, `REINS_KEY`, `REINS_PROJECT`, `REINS_MEMBER`) wins; else `repos[<git toplevel of
cwd, else the main repo root>]` (so any worktree of a configured repo reaches its project) gives url + project and `servers[url]` gives token + member; else the fallbacks
(`http://localhost:4319`, the folder name, git email → `$USER`). Commands written into agent
configs carry only `REINS_SOURCE`, so secrets never land in settings files — and one global
agent config serves every repo, each reporting to its own project.

## Claude Code

The hook streams signals to the Reins server and feeds team state back into your agent:

- **`SessionStart`** → injects a compact team pack (≤ ~300 tokens): directives and assignments
  from the lead, handoffs for you, teammates on your files, the project goal, your goals, and —
  only if you opted in under Settings — your strongest working conventions.
- **`UserPromptSubmit`** → `intent` (what you just asked your agent to do — the gold signal), plus
  a short context delta only when something relevant changed since this session last looked.
- **`PreToolUse`** (Edit / Write / MultiEdit / NotebookEdit) → a non-blocking warning to the model
  when a present teammate edited the same file recently or it's assigned to someone else.
- **`PostToolUse`** (same tools) → records the touched path, relative to the git repo root.
- **`Stop` / `SubagentStop`** → `summary` (what the agent reported back)

Every event also carries git state (branch, short HEAD, dirty files) from the repo, and names
its session: `session`, `source`, `branch`, `worktree` (the git toplevel) and `repo_root` (the
main repo, so several worktrees of one repo are told apart). Prompts with no intent (system-injected
blocks such as `<system-reminder>`, and filler like "ok" or "continue") are dropped client-side;
the pack request still touches the session.

It never blocks or slows your session: writes go out from a detached child; reads the agent waits
on give up after 800ms (context) or 300ms (pre-edit check) and print nothing; it always exits 0.
Set `REINS_CONTEXT=off` to keep capture but turn off injection and the pre-edit check.

Scope: **this repo** writes `.claude/settings.local.json` — Claude Code's personal, git-ignored
file. The hook command holds a machine-specific absolute path (`~/.reins/...`); in the committed
`settings.json` it would break every teammate who pulls (setup also sweeps a stale copy out of
it). **All repos** writes `~/.claude/settings.json`. The command quotes the script path with
forward slashes and pins `shell: bash`, so it works on Windows (Git Bash) as well.

## Other agents

| Agent | Source | Config written | Trigger |
|-------|--------|----------------|---------|
| Codex CLI | `codex` | top-level `notify = ["node", "~/.reins/adapters/codex.mjs"]` in `~/.codex/config.toml` (`$CODEX_HOME` honoured) | Codex runs it with one JSON argument on `agent-turn-complete` (it carries `cwd`, so each repo maps to its own project) |
| OpenCode | `opencode` | plugin `~/.config/opencode/plugins/reins.js` (`$XDG_CONFIG_HOME` honoured) | `message.updated` / `message.part.updated` → the prompt; `session.idle` → the final reply |
| Aider | `aider` | `notifications: true` + `notifications-command: 'node "~/.reins/adapters/aider.mjs"'` in `~/.aider.conf.yml` | aider runs it when a reply is ready; the adapter reads the last reply from `.aider.chat.history.md` (cwd or git root) |
| Generic | `agent` | — | `npx reins-hook install --agent generic --source my-bot` prints a command any agent can pipe JSON into |

All configs are global (per machine, never committed). The installers are idempotent
(re-running updates our entry in place), never overwrite a setting that isn't ours (a
conflicting `notify`, `notifications-command`, `notifications: false` or a foreign
`reins.js` is left as is and setup prints exactly what to change), and `uninstall` removes
only what we added (`# added by reins-hook` tags, the `// reins-hook: managed file` header,
or commands that run from `~/.reins`).

Each adapter exposes a pure mapping function (`mapCodex`, `mapOpencode`, `mapAider`,
`mapGeneric`) and a guarded `main` that reads its agent's payload and ships an
`intent`/`progress`/`summary` event with the right `source`.

For the **generic** adapter: have your agent run
`node ~/.reins/adapters/generic.mjs --source my-bot --kind intent` and pipe a JSON object
(e.g. `{"prompt":"..."}`) or pass `--text "..."`. Configure which field holds the text with
`--fields` / `REINS_TEXT_FIELDS` (a comma list of dot-paths).

### Reins tools (MCP)

Setup also registers the Reins MCP server for Claude Code (`mcpServers.reins` in `~/.claude.json`,
user scope, so no project file is committed), Codex (`[mcp_servers.reins]` in
`~/.codex/config.toml`) and OpenCode (`mcp.reins` in `~/.config/opencode/opencode.json`). Aider has no
MCP. The command is `node ~/.reins/reins-mcp.mjs` with no token; it resolves the server, token,
project and member from `~/.reins/config.json` for the agent's folder. Tools: `reins_context`,
`reins_my_items`, `reins_item_add`, `reins_step_done`, `reins_step_add`, `reins_item_status`,
`reins_ask`, `reins_answer`, `reins_handover`, `reins_note`, `reins_attach`. Teammate context is
background and never overrides the user. `npx reins-hook uninstall` removes the entries; `status`
shows them. Other MCP clients: `npx reins-hook mcp` (flags `--url --token --project --member`).

For agents without a first-class adapter (pi, Hermes, Koda, Cursor, Windsurf, or a plain
script): use the generic adapter, or POST the same JSON to `/api/ingest`. Agents with MCP can
push via the `reins_note` tool instead of a hook (`npx reins-hook mcp`).
