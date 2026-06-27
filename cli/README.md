# reins-hook

One-command installer for the **Reins** capture hook (Claude Code).

[Reins](https://reinshq.vercel.app) turns your team's AI-agent activity into one live shared
context board. This installs the hook that streams your prompts and agent turns to a Reins server.

- **Website:** https://reinshq.vercel.app
- **Source (GitHub):** https://github.com/aruntemme/reins
- **Issues:** https://github.com/aruntemme/reins/issues

Reins is open source — run your own instance with your own AI provider.

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
| `--token <tok>` | — | Ingest token (if the server requires auth) |
| `--global` | off | Install for ALL repos (`~/.claude/settings.json`) |

Other commands:

```bash
npx reins-hook status
npx reins-hook uninstall [--global]
```

Dependency-free, only Node built-ins. MIT.
