# reins

**The live shared context layer for teams who code with AI agents.**

🔗 Live: **[reinshq.vercel.app](https://reinshq.vercel.app)** · install the hook: `npx reins-hook install`

Every teammate's agent already narrates what it's doing. Reins captures that stream, distills
it into living context with a multi-agent LLM pipeline, and serves it as one shared brain — a
dashboard a lead can glance at, and an MCP tool any teammate's agent can pull from. No standups,
no stale `context.md`.

```
 Claude Code hook ──POST──▶ reins server ──distill (triage→extract→reconcile)──▶ living context
                                  │                                                    │
                                  ├──▶ dashboard (Next.js, live via SSE) ──────────────┘
                                  └──▶ MCP server  ("reins_context" / pending / member)──▶ any agent
```

## The pipeline (the part that turns noise into signal)

Raw agent events are a firehose. Reins runs each one through a **multi-agent, tool-calling
pipeline** over any OpenAI-compatible LLM:

1. **Triage** (fast model) — gates noise vs. minor vs. major. Most low-content events stop here.
2. **Extract** — pulls structured facts: intent, actions, files, decisions, blockers, next steps.
3. **Reconcile** (agentic, tool-calling) — merges those facts into the person's living context by
   *calling real tools* that mutate state: `set_headline`, `set_goal`, `set_status`,
   `add_timeline`, `add_pending`, `resolve_pending`, `set_working_on`.
4. **Rollup** (debounced) — synthesizes the whole team into a lead-level status: summary,
   goal-alignment, collisions (two people in the same file), and risks.

If no LLM is configured, Reins degrades gracefully to raw capture (no distillation).

## Quick start

```bash
npm run install:all

# 1) configure the LLM (OpenAI / OpenRouter / Ollama / vLLM / LM Studio — anything OpenAI-compatible)
cp server/.env.example server/.env
#   set REINS_LLM_BASE_URL, REINS_LLM_API_KEY, REINS_LLM_MODEL

# 2) run server + dashboard
npm run dev
#   server    → http://localhost:4319
#   dashboard → http://localhost:4320

# 3) (optional) see it populated without wiring agents
npm run seed                 # writes a pre-distilled demo board to project "reins"
```

Then point an agent at it with one command — installs the capture hook into Claude Code:

```bash
npx reins-hook install --url http://localhost:4319 --me yourname
#   (before publishing: npx ./cli install --me yourname)
# then run /hooks in Claude Code to approve it
```

Every prompt + agent turn now flows into Reins. See [`hooks/README.md`](hooks/README.md) for flags
(`--global`, `--project`, `--key`) and `status` / `uninstall`.

## Retrieve shared context from any agent (MCP)

Register the MCP server so a teammate's agent can pull live context natively:

```json
{ "mcpServers": { "reins": { "command": "npx", "args": ["tsx", "server/src/mcp.ts"], "cwd": "/ABS/PATH/reins" } } }
```

Tools: `reins_context` (project status as agent-ready markdown), `reins_projects`,
`reins_member`, `reins_pending`.

## Layout

| Path | What |
|------|------|
| `server/` | Express ingest + SSE + REST, SQLite, the LLM pipeline, MCP server |
| `web/` | Next.js dashboard (light editorial theme, live over SSE) |
| `cli/` | `reins-hook` — the `npx` installer (bundles the capture hook) |
| `hooks/` | Hook docs (the canonical hook ships inside `cli/`) |
| `deploy/` | [`DEPLOY.md`](deploy/DEPLOY.md) (Vercel + AWS) and the ECR push script |

## Auth & deploy

Local dev runs as a single open instance (`REINS_AUTH=off`). For a shared/deployed instance,
turn on multi-tenant auth: **workspaces** are the tenant boundary, **ingest tokens** authenticate
hooks/agents, **access tokens** authenticate dashboard viewers (httpOnly session cookie), **admin
tokens** mint/revoke. Bootstrap with `npm run admin -- create-workspace "Team"`.

Deploy in two commands: **server + SQLite → AWS Lightsail** (`deploy/lightsail/provision.sh` then
`ship.sh`), **dashboard → Vercel** (set `REINS_URL`). The dashboard proxies `/api/*` to the backend
so the browser stays HTTPS-only and sessions are first-party. Full guide:
[`deploy/DEPLOY.md`](deploy/DEPLOY.md).

## Configuration

All server config is env (`server/.env`) — see `server/.env.example`. Provider-neutral by design:
set `REINS_LLM_BASE_URL` to any OpenAI-compatible endpoint. Set `REINS_LLM_MODEL_FAST` to a
cheaper model for the triage gate.
