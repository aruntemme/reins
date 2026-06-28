# reins

Shared context for teams that build with AI coding agents.

Live: [reinshq.vercel.app](https://reinshq.vercel.app) · install the hook: `npx reins-hook install`

## What it is

When a team codes with AI agents, each agent works on its own. Nobody can see what a teammate's
agent is doing, so people duplicate work, edit the same files blind, and fall back to standups and a
`context.md` that goes stale in a day.

Reins watches what each agent does, distills it into a short per-person and per-team status, and
serves that in two places: a dashboard the team reads, and an MCP server any agent can query before
it starts work.

Capture, distillation, and retrieval all work end to end today.

## How it works

```
Claude Code hook  ->  reins server  ->  distill (triage, extract, reconcile, rollup)
                          |
                          |-- dashboard (Next.js, live over SSE)
                          |-- MCP server (reins_context, reins_projects, ...)
```

A hook in each teammate's Claude Code posts their prompts and agent turns to the server, which runs
each event through a short pipeline and keeps a current status per person and project. The dashboard
streams updates over SSE; the MCP server lets any agent pull the same status as plain markdown.

## The distillation pipeline

Each incoming event is processed in steps so that most of the noise is dropped early:

1. **Triage** (fast model) sorts the event into noise, minor, or major. Low-value events stop here.
2. **Extract** pulls structured facts: intent, actions, files touched, decisions, blockers, next steps.
3. **Reconcile** merges those facts into the person's current status by calling tools that update
   state: `set_headline`, `set_goal`, `set_status`, `add_timeline`, `add_pending`, `resolve_pending`,
   `set_working_on`.
4. **Rollup** (debounced) summarizes the whole team for a lead: a short status, goal alignment,
   collisions (two people in the same file), and risks.

If no model provider is configured, Reins still captures raw events but does not distill them.

## Bring your own model

The whole pipeline runs on any OpenAI-compatible inference provider. Configure one or more providers
from the dashboard (**Settings → model providers**) — base URL, model, and API key — and mark one
active; the pipeline uses the active one. Add as many as you like and switch between them at any time.
API keys are encrypted at rest (AES-256-GCM) on the server and never sent back to the browser.

## What works today

- Capture from several coding agents through one hook core: Claude Code, plus adapters for Codex,
  OpenCode, and Aider, and a generic adapter for any agent that can run a shell command. Every event
  is attributed to its agent, so a team on mixed tools shares one context.
- Distillation through any OpenAI-compatible provider: triage, extract, reconcile, and a debounced team rollup.
- A current status per person (headline, goal, working on, timeline, pending items) and a team
  rollup for a lead (summary, goal alignment, file collisions, risks).
- Short-term goals beneath the project's global goal: admins set common team goals, and each teammate
  keeps their own, each a checklist with progress. An agent can declare and tick its own goals over MCP.
  Auto-tracked: the pipeline watches each teammate's activity and proposes which items look done (and
  new ones it spotted), with a reason and a link to the event, for the owner to confirm or dismiss.
- Handoffs and @mentions, created automatically when two agents touch the same file or one is blocked
  on another's work.
- A live dashboard over SSE, and an MCP server so any agent can read or write the shared context.
- An autonomous agent that watches up-for-grabs work and claims then resolves it over MCP and HTTP,
  so items get picked up without a person typing.
- Scoped retrieval: the MCP context tool narrows to a member or a query and trims to a token budget,
  so an agent pulls only what its task needs.
- Pluggable model providers: add any number of OpenAI-compatible providers in the dashboard, switch the
  active one at any time; keys are encrypted at rest.
- Optional Slack and Discord digests of each rollup.
- Real accounts on the multi-tenant model: sign up for a workspace, log in with email and password,
  invite teammates with a link, and roles (owner, admin, member). Each account links to the identity its
  agent reports as, so the server can tell whose goals and activity are whose. Tokens still authenticate
  hooks and agents, and admins list and revoke them from the dashboard.
- A simple deploy to Vercel plus a small VM.

## Roadmap

- More agent harnesses still. Concrete adapters exist for Claude Code, Codex, OpenCode, and Aider;
  pi, Hermes, and Koda are wired through the generic adapter and the MCP note path for now and will
  get first-class adapters.
- Sub-agents without a human in the loop. The autonomous agent claims and resolves work today; next is
  capturing from sub-agents that a parent agent fans out, so context keeps updating during deep loops.
- Embedding-based retrieval. Scoping ranks by lexical overlap today; swap in embeddings for semantic recall.
- Email for invites and resets. Both work over one-time links today; sending them by email is next.

## Quick start

```bash
npm run install:all

# 1) start server + dashboard
cp server/.env.example server/.env
npm run dev
#   server    on http://localhost:4319
#   dashboard on http://localhost:4320

# 2) add a model provider in the dashboard: Settings -> model providers
#    (base URL, model, API key for any OpenAI-compatible endpoint).
#    Optional: seed a fallback via REINS_LLM_* in server/.env instead.

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

There are two MCP servers. For a teammate on any machine, point the bundled HTTP MCP at your server
with an access token (no clone, no database access):

```bash
claude mcp add reins -- npx reins-hook mcp --url http://localhost:4319 --token <access-token>
# add --ingest-token <ingest-token> to also let the agent post notes
```

For an agent running on the server box itself, register the local MCP, which reads the SQLite file
directly:

```json
{ "mcpServers": { "reins": { "command": "npx", "args": ["tsx", "server/src/mcp.ts"], "cwd": "/ABS/PATH/reins" } } }
```

Tools:

- `reins_context` reads a project's current distilled status (optionally scoped to a member, query, or token budget).
- `reins_projects`, `reins_member`, `reins_pending`, `reins_handoffs`, `reins_goals`, `reins_profile` for narrower reads.
- `reins_note`, `reins_claim`, `reins_resolve`, `reins_handoff_ack`, `reins_goal_add`, `reins_goal_check` let an agent write back.

Running your own instance? [`SELFHOST.md`](SELFHOST.md) is the full guide: backend, database,
dashboard, hook, and both MCP servers, with a complete environment-variable reference.

## Layout

| Path | What |
|------|------|
| `server/` | Express ingest, SSE, REST, SQLite, the distillation pipeline, the MCP server |
| `web/` | Next.js dashboard, light editorial theme, live over SSE |
| `cli/` | `reins-hook`, the `npx` installer that bundles the capture hook |
| `hooks/` | Hook docs (the hook itself ships inside `cli/`) |
| `deploy/` | [`DEPLOY.md`](deploy/DEPLOY.md) and the deploy scripts |

Self-hosting your own instance, end to end? See [`SELFHOST.md`](SELFHOST.md).

## Auth and deploy

Local dev runs as a single open instance (`REINS_AUTH=off`); a shared instance turns it on
(`REINS_AUTH=on`). People sign up for a workspace (the tenant boundary), log in with email and
password, and invite teammates with a one-time link; roles are owner, admin, member. Tokens still
authenticate machines: ingest for hooks and agents, access for viewers, admin to mint or revoke.
Invites and resets use one-time links; email is not wired yet. Admin commands include
`create-workspace`, `claim-workspace`, `reset-link`, `list-workspaces`, and `revoke`.

The dashboard deploys to Vercel, the server and its SQLite database to a small VM. The dashboard
proxies `/api/*` to the backend so the browser stays first party. See [`deploy/DEPLOY.md`](deploy/DEPLOY.md).

## Configuration

Server config is environment variables (`server/.env`, see `server/.env.example`). Model providers
are configured at runtime from the dashboard (**Settings → model providers**) and stored encrypted in
the database. As an optional fallback used only until a provider is added there, set `REINS_LLM_BASE_URL`,
`REINS_LLM_MODEL`, and `REINS_LLM_API_KEY` for any OpenAI-compatible endpoint. Set `REINS_SECRET_KEY`
to a long random value to pin the encryption master key (otherwise one is auto-generated into
`.reins-secret`).
