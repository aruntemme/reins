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
3. **Sign in** — opens your browser at `<url>/cli?code=ABCD-EFGH`. Check the code matches,
   pick the project, approve. The terminal receives its credential — no tokens to copy, and
   teammates don't need an admin to send them one. A saved sign-in that still works is reused.
   (On a server without accounts you pick or name a project instead.)
4. **Agents** — detected agents are pre-ticked; for Claude Code choose this repo or all repos.
5. **Configure** — writes each agent's real config, saves `~/.reins/config.json`, and says
   hello so the board shows you right away. Then: `Open the board: <url>/project/<id>`.

In Claude Code, run `/hooks` once to approve the new hooks (or restart it).

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

## Read the board back (MCP)

The hook *sends* activity to Reins. To let your agent *read* the shared board (and
act on it), add the bundled MCP server. It talks to Reins over the network with
your access token, so any teammate can use it (no repo clone, no local database):

```bash
claude mcp add reins -- npx reins-hook mcp --url https://your-reins --token rk_access_…
# add --ingest-token rk_ingest_… to also let the agent post notes
```

Tools your agent gets: `reins_context`, `reins_member`, `reins_pending`,
`reins_handoffs`, `reins_goals`, `reins_profile`, `reins_claim` / `reins_resolve`,
`reins_handoff_ack`, `reins_goal_add` / `reins_goal_check`, and `reins_note`.

Any MCP client works; the command is `npx reins-hook mcp --url <url> --token <access-token>`.

Dependency-free, only Node built-ins (Node ≥ 22). MIT.
