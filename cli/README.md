# reins-hook

One-command setup for **Reins**: sign in from your terminal and wire your coding
agents (Claude Code, Codex CLI, OpenCode, Aider) to a live shared team-context board.

[Reins](https://reinshq.vercel.app) turns your team's AI-agent activity into one live shared
context board, and feeds team state back into your agent.

- **Website:** https://reinshq.vercel.app
- **Source (GitHub):** https://github.com/aruntemme/reins
- **Issues:** https://github.com/aruntemme/reins/issues

Reins is open source. Run your own instance with your own AI provider.

## Setup

Run it in your repo (the project's Connect page shows the exact command):

```bash
npx reins-hook --url https://reins.yourco.com --project checkout-v2
```

The wizard:

1. **Repository** — finds the git root, repo name, branch and your git email.
2. **Server** — `--url`, else this repo's saved server, else the last one you used, else
   `https://reinshq.vercel.app`; checks `/health`.
3. **Agents** — detected agents are pre-ticked; for Claude Code choose this repo or all repos.
4. **Sign in** — opens your browser at `<url>/cli?code=ABCD-EFGH`. Check the code matches,
   pick the project, approve. The terminal receives its credential — no tokens to copy, and
   teammates don't need an admin to send them one. A saved sign-in that still works is reused.
   (On a server without accounts you pick or name a project instead.)
5. **Configure** — writes each agent's real config, saves `~/.reins/config.json`, and says
   hello so the board shows you right away. Then: `Open the board: <url>/project/<id>`.

In Claude Code, run `/hooks` once to approve the new hooks (or restart it). After upgrading
reins-hook, run setup again so new hooks get wired.

What each agent sends: Claude Code sends prompts, the agent's replies, the files it edits and its
test runs (passed or failed; `npm test`, `pytest`, `go test`, `node --test`, …), and gets a short
team pack back at session start and when something relevant changes. Codex, OpenCode and Aider
send prompts and replies. Secrets are masked on your machine before anything is sent.

| Agent | What gets written |
|-------|-------------------|
| Claude Code | hooks in `.claude/settings.local.json` (this repo, personal, git-ignored) or `~/.claude/settings.json` (all repos) |
| Codex CLI | top-level `notify` in `~/.codex/config.toml` |
| OpenCode | plugin `~/.config/opencode/plugins/reins.js` |
| Aider | `notifications` + `notifications-command` in `~/.aider.conf.yml` |

Every command written carries only `REINS_SOURCE`. The server, token, member and project
resolve at runtime from `~/.reins/config.json` (mode `0600`) by the repo's git root, so no
secret ever lands in an agent settings file. Re-running updates everything in place; a setting
that belongs to you (say, your own Codex `notify`) is left alone and the wizard tells you
exactly what to change.

Setup flags (also make it run headless, e.g. in a script): `--url`, `--project`,
`--agents claude-code,codex,opencode,aider`, `--scope repo|global`, `--no-open`, `--yes`.

## Other commands

```bash
npx reins-hook status            # server, who you are, repo → project, which agents are wired
npx reins-hook uninstall         # remove all agent wiring we added (+ this repo's mapping)
npx reins-hook uninstall --all   # …and forget saved sign-ins
```

### CI and scripts

```bash
npx reins-hook install --agent claude-code,codex --url https://reins.yourco.com \
  --project checkout-v2 --token rk_ingest_…
```

Writes the same agent configs without prompts and stores the token in `~/.reins/config.json`.
Flags: `--agent`, `--url`, `--project`, `--token` (alias `--key`), `--me`, `--global`, `--source`.
`--agent generic --source my-bot` prints a command any agent can pipe JSON into.

Explicit env vars (`REINS_URL`, `REINS_KEY`, `REINS_PROJECT`, `REINS_MEMBER`) always win over
the config file, so installs that embedded them keep working.

## Reins tools for your agent (MCP)

Setup also registers the Reins MCP server, so your agent can see the board and act on it:
what it is on, its open steps, questions waiting for it, what teammates are doing. It can add
an item, tick a step, set a status, ask a teammate a question (only when the answer lives in
their work), answer one, hand an item over, and post a short note or finding.

| Agent | Where it is registered |
|-------|------------------------|
| Claude Code | `mcpServers.reins` in `~/.claude.json` (user scope: no project file is created or committed) |
| Codex CLI | `[mcp_servers.reins]` in `~/.codex/config.toml` |
| OpenCode | `mcp.reins` in `~/.config/opencode/opencode.json` |
| Aider | none (Aider has no MCP; capture still works) |

The command is `node ~/.reins/reins-mcp.mjs` and carries no token: it reads
`~/.reins/config.json` for the folder the agent runs in (worktrees included), like the hook.
`npx reins-hook uninstall` removes it. Tools: `reins_context`, `reins_my_items`, `reins_item_add`,
`reins_step_done`, `reins_step_add`, `reins_item_status`, `reins_ask`, `reins_answer`,
`reins_handover`, `reins_note`, `reins_attach`.

Any other MCP client can run `npx reins-hook mcp` (flags `--url`, `--token`, `--project`,
`--member` override what is saved). Older setups keep working: `--ingest-token`, or an
`rk_access_…` `--token`, selects the previous tool set.

Dependency-free, only Node built-ins (Node ≥ 22). MIT.
