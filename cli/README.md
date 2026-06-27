# reins-hook

One-command installer for the **Reins** capture hook (Claude Code).

[Reins](https://reinshq.vercel.app) turns your team's AI-agent activity into one live shared
context board. This installs the hook that streams your prompts and agent turns to a Reins server.

- **Website:** https://reinshq.vercel.app
- **Source (GitHub):** https://github.com/aruntemme/reins
- **Issues:** https://github.com/aruntemme/reins/issues

Reins is open source. Run your own instance with your own AI provider.

## Usage

```bash
npx reins-hook install --url https://reins.yourco.com --me asha
# then run /hooks in Claude Code to approve it
```

It copies the hook to `~/.reins/reins-hook.mjs` and **merges** it into your
`.claude/settings.json` without touching your other hooks (idempotent).

| Flag | Default | Meaning |
|------|---------|---------|
| `--url <url>` | `http://localhost:4319` | Reins server |
| `--me <name>` | git email → `$USER` | Who you are |
| `--project <id>` | folder name | Project scope |
| `--token <tok>` | (none) | Ingest token (if the server requires auth) |
| `--global` | off | Install for ALL repos (`~/.claude/settings.json`) |

Other commands:

```bash
npx reins-hook status
npx reins-hook uninstall [--global]
```

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

Dependency-free, only Node built-ins. MIT.
