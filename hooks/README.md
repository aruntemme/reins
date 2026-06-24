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
`.claude/settings.json` (without touching other hooks). Then run `/hooks` in
Claude Code to approve it (or restart).

| Flag | Default | Meaning |
|------|---------|---------|
| `--url <url>` | `http://localhost:4319` | Reins server |
| `--me <name>` | git email → `$USER` | Who you are |
| `--project <id>` | folder name | Project scope |
| `--key <secret>` | — | Ingest secret (match `REINS_INGEST_KEY`) |
| `--global` | off | Install for ALL repos (`~/.claude/settings.json`) |

Other commands: `npx reins-hook status`, `npx reins-hook uninstall [--global]`.

> Running from this repo before publishing to npm? Use `npx ./cli install …`
> (or `node cli/bin.mjs install …`). The CLI source is in [`../cli`](../cli).

## Other agents

Any agent that can run a shell command on prompt/stop can feed Reins — just POST
the same JSON to `/api/ingest`. Cursor, Windsurf, or a plain script all work.
Agents with MCP can also push via the `reins_note` tool instead of a hook.
