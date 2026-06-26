# Reins capture hook (Claude Code)

The hook streams two signals to the Reins server:

- **`UserPromptSubmit`** → `intent` (what you just asked your agent to do — the gold signal)
- **`Stop` / `SubagentStop`** → `summary` (what the agent reported back)

It never blocks your session: 1.5s timeout, always exits 0.

## Install (one command)

```bash
npx reins-hook install --url https://reins.yourco.com --me asha
```

This copies the hook to `~/.reins/reins-hook.mjs` and **merges** it into your
`.claude/settings.local.json` (your personal, git-ignored settings) without
touching other hooks. Then run `/hooks` in Claude Code to approve it (or restart).

> Why `settings.local.json` and not the shared `settings.json`? The hook command
> embeds a machine-specific absolute path (`~/.reins/...`). If that goes in the
> committed `settings.json`, every teammate who pulls the repo runs a path that
> doesn't exist on their machine and Claude Code reports a missing-module error
> on each prompt. `--global` writes `~/.claude/settings.json` (already personal).

| Flag | Default | Meaning |
|------|---------|---------|
| `--agent <name>` | `claude-code` | Which agent harness (see below) |
| `--source <id>` | the agent's id | Override the source label events carry |
| `--url <url>` | `http://localhost:4319` | Reins server |
| `--me <name>` | git email → `$USER` | Who you are |
| `--project <id>` | folder name | Project scope |
| `--key <secret>` | — | Ingest secret (match `REINS_INGEST_KEY`) |
| `--global` | off | Install for ALL repos (`~/.claude/settings.json`) |

Other commands: `npx reins-hook status`, `npx reins-hook uninstall [--global]`.

> Running from this repo before publishing to npm? Use `npx ./cli install …`
> (or `node cli/bin.mjs install …`). The CLI source is in [`../cli`](../cli).

## Bring your own agent (`--agent`)

A whole team on mixed coding agents can share one Reins context. `--agent`
copies the right adapter to `~/.reins/adapters/`, sets `REINS_SOURCE`, and merges
the command into your settings (foreign hooks are left untouched). Known agents:

| `--agent` | Source | Integration |
|-----------|--------|-------------|
| `claude-code` | `claude-code` | Native Claude Code hook (default) |
| `codex` | `codex` | Codex CLI `notify` program (concrete) |
| `opencode` | `opencode` | OpenCode plugin/event bus (concrete) |
| `aider` | `aider` | Aider `--notifications-command` + chat history (concrete) |
| `generic` | `agent` | Universal: any agent that can run a shell command |

```bash
npx reins-hook install --agent codex --me asha
npx reins-hook install --agent opencode --me rui
npx reins-hook install --agent aider --me lee
npx reins-hook install --agent generic --source my-bot --me asha
```

Each adapter exposes a pure mapping function (`mapCodex`, `mapOpencode`,
`mapAider`, `mapGeneric`) and a guarded `main` that reads its agent's payload and
ships an `intent`/`progress`/`summary` event with the right `source`.

### Wiring each agent's trigger

The installer records the command in your settings (`settings.local.json` for a
project install, `~/.claude/settings.json` with `--global`); point the agent's
own trigger at the printed command (it lives under `~/.reins`):

- **Codex** — in `~/.codex/config.toml` set
  `notify = ["node", "/Users/you/.reins/adapters/codex.mjs"]`. Codex passes the
  event JSON as the first argument; the adapter also reads stdin as a fallback.
- **OpenCode** — add a tiny plugin that subscribes to the event bus and pipes the
  event JSON to `node ~/.reins/adapters/opencode.mjs`.
- **Aider** — run aider with
  `--notifications-command "node /Users/you/.reins/adapters/aider.mjs"`. With no
  stdin payload the adapter reads the latest assistant turn from
  `.aider.chat.history.md` (override with `--history` / `AIDER_CHAT_HISTORY`).
- **Generic** — have your agent run
  `node ~/.reins/adapters/generic.mjs --source my-bot --kind intent` and pipe a
  JSON object (e.g. `{"prompt":"..."}`) or pass `--text "..."`. Configure which
  field holds the text with `--fields` / `REINS_TEXT_FIELDS` (a comma list of
  dot-paths).

## Other agents (generic + MCP)

For agents without a first-class adapter (pi, Hermes, Koda, Cursor, Windsurf,
or a plain script): use the **generic** adapter above, or just POST the same JSON
to `/api/ingest`. Agents with MCP can push via the `reins_note` tool instead of a
hook. The OpenAdapter-family agents (pi, Koda, Hermes) are MCP-capable, so the
`reins_note` path is the recommended integration until their concrete adapters
land.
