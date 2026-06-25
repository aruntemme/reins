# reins

Shared context for teams that build with AI coding agents.

Live: [reinshq.vercel.app](https://reinshq.vercel.app) · install the hook: `npx reins-hook install`

## What it is

When a team codes with AI agents, each person's agent works on its own. Nobody can easily see
what a teammate's agent is doing, so people duplicate work, edit the same files without knowing,
and fall back to standups and a `context.md` that goes stale within a day.

Reins watches what each agent is doing, summarizes it into a short per-person and per-team status,
and makes that status available in two places: a dashboard the team can read, and an MCP server any
teammate's agent can query before it starts work.

It is a small project, built for the 0G Zero Cup. The capture, the distillation, and the
retrieval all work end to end today.

## How it works

```
Claude Code hook  ->  reins server  ->  distill (triage, extract, reconcile, rollup)
                          |
                          |-- dashboard (Next.js, live over SSE)
                          |-- MCP server (reins_context, reins_pull_context, ...)
```

A hook in each teammate's Claude Code posts their prompts and agent turns to the reins server.
The server runs each event through a short pipeline and keeps a current status per person and per
project. The dashboard streams updates over SSE, and the MCP server lets any agent pull the same
status as plain markdown.

## The distillation pipeline

Each incoming event is processed in steps so that most of the noise is dropped early:

1. **Triage** (fast model) sorts the event into noise, minor, or major. Low-value events stop here.
2. **Extract** pulls structured facts: intent, actions, files touched, decisions, blockers, next steps.
3. **Reconcile** merges those facts into the person's current status by calling tools that update
   state: `set_headline`, `set_goal`, `set_status`, `add_timeline`, `add_pending`, `resolve_pending`,
   `set_working_on`.
4. **Rollup** (debounced) summarizes the whole team for a lead: a short status, goal alignment,
   collisions (two people in the same file), and risks.

If no inference backend is configured, Reins still captures raw events but does not distill them.

## Where 0G fits

- **Inference runs on 0G Compute.** The whole pipeline above calls the 0G Private Computer router,
  which is OpenAI compatible.
- **Snapshots live on 0G Storage.** Each context snapshot is written to 0G Storage and addressed by
  its Merkle root hash, so the shared context can be pulled and verified from anywhere, not only
  from this server's database. The MCP `reins_pull_context` tool rebuilds a snapshot from a hash
  alone, with no local state, which is something a plain database cannot do.

## What works today

The pipeline is built around teams of people who each run a coding agent. What is working now:

- Capture from several coding agents through one hook core: Claude Code, plus adapters for Codex,
  OpenCode, and Aider, and a generic adapter for any agent that can run a shell command. Every event
  is attributed to the agent that produced it, so a team on mixed tools shares one context.
- Distillation on 0G Compute: triage, extract, reconcile, and a debounced team rollup.
- A current status per person (headline, goal, what they are working on, recent timeline, pending items).
- A team rollup for a lead: summary, goal alignment, file collisions, and risks.
- Handoffs and @mentions, created automatically when two agents touch the same file or one is blocked on another's work.
- A live dashboard over SSE, and an MCP server so any teammate's agent can read or write the shared context.
- An autonomous agent that watches up-for-grabs work and claims then resolves it through the MCP and
  HTTP write paths, so items get picked up without a person typing.
- Smarter retrieval: the MCP context tool can scope to a member or a query and trim to a token budget,
  so an agent pulls only what is relevant to its task.
- Verifiable, portable snapshots on 0G Storage, including `reins_pull_context` to rebuild context from a
  hash, and cross-instance sync (`reins_sync_push` / `reins_sync_pull`) so two instances share context
  by handing over a single root hash, with no shared server.
- Optional on-chain anchoring on 0G Chain: every snapshot root hash can be committed as a tamper-evident,
  publicly auditable transaction.
- Optional Slack and Discord digests of each rollup for the humans who want a glance.
- Real accounts on top of the multi-tenant model: sign up to get your own workspace, log in with
  email and password, invite teammates with a link, and roles (owner, admin, member). Tokens still
  authenticate hooks and agents, and admins can list and revoke them from the dashboard.
- A simple deploy to Vercel plus a small VM.

## Roadmap

- More agent harnesses still. Concrete adapters exist for Claude Code, Codex, OpenCode, and Aider;
  pi, Hermes, and Koda are wired through the generic adapter and the MCP note path for now and will
  get first-class adapters.
- Sub-agents without a human in the loop. The autonomous agent claims and resolves work today; next is
  capturing from sub-agents that a parent agent fans out, so context keeps updating during deep loops.
- Embedding-based retrieval. Scoping ranks by lexical overlap today; swap in embeddings for semantic recall.
- Richer on-chain provenance. Anchoring writes a witness transaction today; a small contract could index
  the full history of a workspace's snapshot hashes.

Todos:

- Email for invites and password resets. Both work over one-time links today; sending them by email is next.

## Quick start

```bash
npm run install:all

# 1) configure inference (runs on 0G Compute, via the 0G Private Computer router)
cp server/.env.example server/.env
#   set REINS_LLM_PROVIDER=0g-router, OG_ROUTER_API_KEY, REINS_LLM_MODEL, OG_STORAGE=on
#   (or REINS_LLM_PROVIDER=openai with REINS_LLM_BASE_URL for any OpenAI-compatible endpoint)

# 2) run server + dashboard
npm run dev
#   server    on http://localhost:4319
#   dashboard on http://localhost:4320

# 3) optional: populate a demo board without wiring agents
npm run seed
```

## Connect an agent

One command installs the capture hook into Claude Code:

```bash
npx reins-hook install --url http://localhost:4319 --me yourname
# then run /hooks in Claude Code to approve it
```

Every prompt and agent turn now flows into Reins. On a shared instance, pass the ingest token from
your dashboard with `--token`. See [`hooks/README.md`](hooks/README.md) for flags (`--global`,
`--project`, `--token`) and the `status` and `uninstall` commands.

## Pull context from an agent (MCP)

Register the MCP server so a teammate's agent can read the shared context:

```json
{ "mcpServers": { "reins": { "command": "npx", "args": ["tsx", "server/src/mcp.ts"], "cwd": "/ABS/PATH/reins" } } }
```

Tools:

- `reins_context` reads a project's current status, fetched and verified from 0G Storage.
- `reins_pull_context` rebuilds a snapshot from a 0G Storage root hash alone, with no database.
- `reins_projects`, `reins_member`, `reins_pending`, `reins_handoffs` for narrower reads.
- `reins_note`, `reins_claim`, `reins_resolve`, `reins_handoff_ack` let an agent write back.

## Layout

| Path | What |
|------|------|
| `server/` | Express ingest, SSE, REST, SQLite, the distillation pipeline, the MCP server |
| `web/` | Next.js dashboard, light editorial theme, live over SSE |
| `cli/` | `reins-hook`, the `npx` installer that bundles the capture hook |
| `hooks/` | Hook docs (the hook itself ships inside `cli/`) |
| `deploy/` | [`DEPLOY.md`](deploy/DEPLOY.md) and the deploy scripts |

## Auth and deploy

Local dev runs as a single open instance (`REINS_AUTH=off`). For a shared instance, turn it on
(`REINS_AUTH=on`). People sign up to get their own workspace, log in with email and password, and
invite teammates with a one-time link; roles are owner, admin, and member. Workspaces are the tenant
boundary. Tokens still authenticate machines: ingest for hooks and agents, access for viewers, admin
to mint or revoke. Invites and resets use one-time links for now; email is not wired yet. Admin
commands include `create-workspace`, `claim-workspace`, `reset-link`, `list-workspaces`, and `revoke`.

The dashboard deploys to Vercel and the server with its SQLite database to a small VM. The dashboard
proxies `/api/*` to the backend so the browser stays first party. See [`deploy/DEPLOY.md`](deploy/DEPLOY.md).

## Configuration

All server config is environment variables (`server/.env`, see `server/.env.example`). Inference
runs on 0G Compute (`REINS_LLM_PROVIDER=0g-router` with `OG_ROUTER_API_KEY`) and snapshots persist
to 0G Storage (`OG_STORAGE=on`). To use a different inference backend, set `REINS_LLM_PROVIDER=openai`
with `REINS_LLM_BASE_URL` and any OpenAI-compatible endpoint.
