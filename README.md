# reins

Shared context for teams that build with AI coding agents.

Live: [reinshq.vercel.app](https://reinshq.vercel.app) · connect your repo and agents: `npx reins-hook`

## What it is

When a team codes with AI agents, each agent works on its own. Nobody can see what a teammate's
agent is doing, so people duplicate work, edit the same files blind, and fall back to standups and a
`context.md` that goes stale in a day.

Reins watches what each agent does and shows it as owned work: each person's features, bugs and
chores, with every agent as a lane (its branch, worktree, state and last line). Questions and
decisions an agent needs from a person surface as "Needs you" and are answered in place. The same
state flows back into each agent, which can track its own work, hand it over, and ask a teammate's
agent a question.

Capture, distillation, the board and the agent tools all work end to end today.

## How it works

```
agent hooks / adapters  ->  reins server  ->  sessions, items, posts  +  distill (triage, extract, reconcile, rollup)
                                 |
                                 |-- dashboard (Next.js, live over SSE)
                                 |-- team pack injected into each agent (hook)
                                 |-- MCP tools (reins_my_items, reins_ask, reins_handover, ...)
```

A hook in each teammate's agent posts their prompts, agent turns, file edits and test runs to the
server. The server keeps one session per agent per worktree, attaches it to the item on the same
branch, and runs prompts and turns through a short pipeline for a per-person status. The dashboard
streams updates over SSE; the hook injects a short team pack into the agent; the MCP tools let the
agent read and change the board.

## The distillation pipeline

By default (`REINS_PIPELINE_MODE=combined`) each incoming event takes **one** model call that does
three jobs at once; `REINS_PIPELINE_MODE=multi` runs them as separate calls:

1. **Triage** sorts the event into noise, minor, or major. Noise stops here.
2. **Extract** pulls structured facts: intent, actions, files touched, decisions, blockers, next steps.
3. **Reconcile** merges those facts into the person's current status as a small set of updates:
   headline, goal, status, working-on files, new timeline entries, pending items added or resolved.

Then a **rollup** summarizes the whole team for a lead: a short status, goal alignment, collisions,
and risks. It runs once the queue settles, at most once a minute per project. Collisions are
computed, not guessed: when two present teammates list the same file in what they're working on,
both get a collision handoff and the rollup reports it.

Captured text is redacted for secrets on the machine and again on the server, and is passed to the
model as fenced, untrusted data. Events still queued when the server stops are picked up again on
the next start.

If no model provider is configured, Reins still captures raw events but does not distill them.

## Bring your own model

The whole pipeline runs on any OpenAI-compatible inference provider. Configure one or more providers
from the dashboard (**Settings → model providers**) — base URL, model, and API key — and mark one
active; the pipeline uses the active one. Add as many as you like and switch between them at any time.
API keys are encrypted at rest (AES-256-GCM) on the server and never sent back to the browser.

## What works today

- A calm board built around owned work. **Today** shows what needs you, each person's items with
  their agents as lanes, and a tape of handovers, questions, decisions, finishes and findings.
  **My day**, **This week**, an **Item** page (steps, thread, agents on it) and a **Person** page
  fill in the rest; a shared release is optional. Light, dark or system theme, and a phone layout.
- **Needs you**: questions and decisions from agents are answered in place (or handed to your own
  agent to answer from its context), blocked work can be unblocked or reassigned, and same-file
  overlaps can be flagged to both people. An item waiting on a question goes back to doing once it
  is answered.
- Agents work the board too: over MCP an agent sees its items and the questions waiting for it, adds
  items, ticks or adds steps, sets a status, asks a teammate's agent a question, answers one, hands
  an item over, and posts a note or finding. Address people by name, `@handle` or the board's label.
- Test runs are captured: in Claude Code, `npm test`, `pytest`, `go test`, `node --test` and other
  test commands show on the agent's timeline as passed or failed.
- One-command setup: `npx reins-hook` signs you in through the browser (no tokens to copy), wires the
  agents it finds, and puts you on the board.
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
- Handoffs and @mentions, created automatically when two present teammates are working on the same
  file (from each one's distilled working-on list), when one is blocked on another's work, or when
  someone names a teammate.
- Team state flows back into the agent automatically: the Claude Code hook injects a compact team
  pack at session start and a short delta on a prompt only when something relevant changed, and
  warns the model (never blocks) before it edits a file a present teammate just touched or the lead
  assigned to someone else.
- Real file touches and git state (branch, dirty files) from the hook, so collisions show the moment
  they happen; two people on the same work branch count too. A merge (the default branch now holds
  the member's last commit, or their agent reports a merged PR) settles their blockers. Admins can
  hide branch names.
- Collision and blocker handoffs close themselves when the overlap ends, the blocking item is
  resolved, or the work merged — with the reason recorded and a one-click reopen.
- Lead actions: owners/admins assign an area to one person from a collision or risk, and post
  directives to members or the whole team (they expire); both reach agents on their next turn.
- A live dashboard over SSE, and an MCP server so any agent can read or write the shared context.
- An autonomous agent that watches up-for-grabs work and claims then resolves it over MCP and HTTP,
  so items get picked up without a person typing.
- Scoped retrieval: the context tool in both MCP servers narrows to a member or a query and trims to a
  token budget, so an agent pulls only what its task needs.
- Pluggable model providers: add any number of OpenAI-compatible providers in the dashboard, switch the
  active one at any time; keys are encrypted at rest.
- Optional Slack and Discord digests of each rollup. The webhooks are instance-wide, so they post only
  for a single-tenant instance (auth off) or the `default` workspace.
- Real accounts on the multi-tenant model: sign up for a workspace, log in with email and password,
  invite teammates with a link (signing up from it joins that workspace), and roles (owner, admin,
  member). Each account links to the identity its agent reports as, so the server can tell whose
  goals and activity are whose. Each terminal gets its own token when you approve it in the browser;
  admins can also mint tokens for CI, and list and revoke them from the dashboard.
- A simple deploy to Vercel plus a small VM.

## Roadmap

- More agent harnesses still. Concrete adapters exist for Claude Code, Codex, OpenCode, and Aider;
  pi, Hermes, and Koda are wired through the generic adapter and the MCP note path for now and will
  get first-class adapters.
- Sub-agents without a human in the loop. The autonomous agent claims and resolves work today; next is
  capturing from sub-agents that a parent agent fans out, so context keeps updating during deep loops.
- Embedding-based retrieval. Scoping ranks by lexical overlap today (IDF-weighted, with light stemming);
  swap in embeddings for semantic recall.
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

## Connect your agents

In the repo you code in (the project's **Connect** page shows the exact command):

```bash
npx reins-hook --url http://localhost:4319 --project <id>
```

The wizard finds the repo, asks which agents to wire (Claude Code, Codex, OpenCode, Aider), signs you
in through the browser, writes each agent's config and registers the Reins tools. In Claude Code, run
`/hooks` once to approve the hooks (or restart it). Prompts, agent turns, file edits and test runs now
flow into Reins. See [`cli/README.md`](cli/README.md) for flags, `status`, `uninstall`, and the
non-interactive `install` for CI.

## Let agents read and act on the board (MCP)

Setup registers the Reins MCP server for Claude Code, Codex and OpenCode, with no token in their
config (it reads `~/.reins/config.json`). Tools: `reins_context`, `reins_my_items`, `reins_item_add`,
`reins_step_done`, `reins_step_add`, `reins_item_status`, `reins_ask`, `reins_answer`,
`reins_handover`, `reins_note`, `reins_attach`. Any other MCP client can run `npx reins-hook mcp`.

For an agent running on the server box itself there is also a local MCP that reads the SQLite file
directly (`server/src/mcp.ts`); see [`SELFHOST.md`](SELFHOST.md), section 7.

Running your own instance? [`SELFHOST.md`](SELFHOST.md) is the full guide: backend, database,
dashboard, hook, and both MCP servers, with a complete environment-variable reference.

## Layout

| Path | What |
|------|------|
| `server/` | Express ingest, SSE, REST, SQLite, the distillation pipeline, the MCP server |
| `web/` | Next.js dashboard, light and dark themes, live over SSE |
| `cli/` | `reins-hook`: the setup wizard, the capture hook and adapters, and the MCP server |
| `hooks/` | Hook docs (the hook itself ships inside `cli/`) |
| `deploy/` | [`DEPLOY.md`](deploy/DEPLOY.md) and the deploy scripts |

Self-hosting your own instance, end to end? See [`SELFHOST.md`](SELFHOST.md).

## Auth and deploy

Local dev runs as a single open instance (`REINS_AUTH=off`); a shared instance turns it on
(`REINS_AUTH=on`). People sign up for a workspace (the tenant boundary), log in with email and
password, and invite teammates with a one-time link; roles are owner, admin, member. Tokens
authenticate machines: ingest for hooks and agents (each terminal gets one when you approve its
sign-in), access for viewers, admin to mint or revoke.
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
