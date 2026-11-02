# Self-hosting Reins

Run your own Reins instance, end to end, with your own AI provider. This guide covers every
piece: the backend, the database, the dashboard, the capture hook, and both MCP servers, plus how
they connect to each other.

If you just want the maintainer's exact Lightsail + Vercel deploy, see
[`deploy/DEPLOY.md`](deploy/DEPLOY.md). This document is the provider-agnostic reference for
running the whole thing yourself.

## Contents

1. [How the pieces fit](#1-how-the-pieces-fit)
2. [Prerequisites](#2-prerequisites)
3. [Backend (server)](#3-backend-server)
4. [Database (SQLite)](#4-database-sqlite)
5. [Frontend (dashboard)](#5-frontend-dashboard)
6. [The capture hook (CLI)](#6-the-capture-hook-cli)
7. [MCP: let agents read and write the board](#7-mcp-let-agents-read-and-write-the-board)
8. [Auth and tokens](#8-auth-and-tokens)
9. [Putting it together: a full local setup](#9-putting-it-together-a-full-local-setup)
10. [Production notes](#10-production-notes)
11. [Full environment variable reference](#11-full-environment-variable-reference)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. How the pieces fit

```
                          your AI provider (any OpenAI-compatible endpoint)
                                          ^
                                          | inference (distillation)
                                          |
  capture hook ---- POST /api/ingest ---> reins server (Express) ---> SQLite (on disk)
  (per teammate)                              |   ^
                                              |   |
                          dashboard <--SSE----     ---- MCP servers (read + write)
                          (Next.js)                        local stdio  |  remote HTTP
```

- The **backend** is an Express server. It takes raw activity at `POST /api/ingest`, runs it through
  the distillation pipeline (your AI provider), and keeps a current per-person and per-team status in
  **SQLite**.
- The **dashboard** is a Next.js app. It proxies `/api/*` to the backend and streams live updates
  over SSE.
- The **capture hook** runs inside each teammate's coding agent (Claude Code, Codex, etc.) and posts
  their prompts and agent turns to `POST /api/ingest`, plus file edits and test runs to `/api/hook/*`.
- Two **MCP servers** let an agent read and write the shared board: one runs on the server box and
  reads SQLite directly, the other runs anywhere and talks to the backend over HTTP.

Everything stores into the one SQLite file. The hook and both MCP servers all reach the same data:
the hook and the HTTP MCP go through the backend's API, and the local MCP reads the database file on
the box directly (and calls the backend for writes).

---

## 2. Prerequisites

- **Node.js 22** (the Docker image uses `node:22`; the CLI declares `>=22`).
- **An OpenAI-compatible inference endpoint.** Anything that speaks the OpenAI API works: OpenAI,
  OpenRouter, Together, Groq, a local vLLM, Ollama, or LM Studio.
  Without one, Reins still captures raw events but will not distill them into status.
- `git`, and a coding agent (Claude Code) on each teammate's machine for the hook.

Clone and install all workspaces:

```bash
git clone https://github.com/aruntemme/reins.git
cd reins
npm run install:all
```

---

## 3. Backend (server)

The backend lives in `server/`. It is Express + `better-sqlite3`, run with `tsx`.

### Configure

```bash
cp server/.env.example server/.env
```

There are two ways to configure inference:

**Recommended -- configure model providers in the dashboard.** Once the backend and dashboard
are running, go to **Settings -> model providers** and add a provider (base URL, model, API key).
Provider API keys are encrypted at rest (AES-256-GCM) with `REINS_SECRET_KEY` as the master key
(auto-generated into `.reins-secret` if you do not set one).

**Fallback -- set env vars in `server/.env`.** If no provider is configured in the dashboard, the
backend falls back to these:

```bash
REINS_LLM_BASE_URL=https://api.openai.com/v1   # or OpenRouter / Ollama / vLLM / LM Studio
REINS_LLM_API_KEY=sk-...                        # any non-empty string for local servers
REINS_LLM_MODEL=gpt-4o                          # your main reasoning model
REINS_LLM_MODEL_FAST=gpt-4o-mini                # optional cheaper model for the triage gate
```

See the [full env reference](#11-full-environment-variable-reference) for every variable.

### Run

```bash
cd server
npm run dev     # watch mode, hot-reloads on change
# or
npm start       # plain start (production)
```

The server listens on `PORT` (default **4319**). On boot it prints which inference backend it
inferred, or `NOT CONFIGURED` if none. Check health:

```bash
curl http://localhost:4319/health
```

### Key endpoints

- `POST /api/ingest` -- where the hook and HTTP MCP post activity.
- `GET /api/projects`, `GET /api/projects/:id`, `GET /api/projects/:id/goals`, etc. -- reads the
  dashboard and MCP servers use.
- `GET /api/stream` -- SSE stream the dashboard subscribes to.
- `POST /api/auth/*` -- signup, signin, invites (when `REINS_AUTH=on`).

---

## 4. Database (SQLite)

Reins uses a single SQLite file with WAL mode. There is **no migration step**: the schema is created
on boot with `CREATE TABLE IF NOT EXISTS`, so the file is created and kept up to date automatically
the first time the server starts.

- **Location:** the `REINS_DB` env var. Default `./reins.db` (relative to the server's working
  directory); the Docker image uses `/data/reins.db` on a persistent volume.
- **Companion files:** SQLite in WAL mode also writes `reins.db-wal` and `reins.db-shm`. These are
  normal; leave them next to the main file. All three are gitignored (`*.db`, `*.db-wal`, `*.db-shm`).
- **What it holds:** workspaces, users, memberships, tokens, projects, raw events, per-member state,
  timeline, pending items, handoffs, goals and checklist items, the team rollup, and the encrypted
  model-provider settings.

### Backups

The database is one file. To back it up safely while the server runs, use SQLite's online backup
rather than copying the file mid-write:

```bash
# from the server directory
sqlite3 reins.db ".backup 'backup-$(date +%F).db'"
```

In Docker:

```bash
docker compose exec reins sqlite3 /data/reins.db ".backup '/data/backup.db'"
```

### Where the hook and MCP data all lands

This is the important part for self-hosting: **everything funnels into this one database.**

- The **hook** posts to `POST /api/ingest`; the server distills and writes member state, timeline,
  handoffs, etc. into SQLite.
- The **local MCP** (`server/src/mcp.ts`) opens this same SQLite file directly for reads, and calls
  the backend's HTTP API for writes (so writes go through the same validation path as everything else).
- The **HTTP MCP** (`npx reins-hook mcp`) never touches the file; it reads and writes only through the
  backend's API over the network.

So if you self-host, you point the hook and the HTTP MCP at your server's URL, and they share the same
board automatically. The local MCP is only for agents running on the server box itself.

---

## 5. Frontend (dashboard)

The dashboard lives in `web/` (Next.js 15, React 19). It does **not** talk to a database. It proxies
API calls to the backend and renders the live board.

### How it reaches the backend

`web/next.config.mjs` rewrites `/api/*` and `/health` to the backend URL, server-side. This keeps the
browser same-origin (cookies stay first-party, no CORS needed). You control the backend URL with one
env var:

| Env var | Default | Purpose |
|---|---|---|
| `REINS_URL` | `http://localhost:4319` | Backend the dashboard proxies to (server-side rewrite). |
| `NEXT_PUBLIC_REINS_URL` | (unset) | Optional. If set, the browser connects SSE **directly** to the backend instead of through the rewrite. Requires the backend's `REINS_CORS_ORIGIN` to include the dashboard's origin. Most setups should leave this unset and rely on the rewrite. |

### Run

```bash
cd web
npm run dev      # dev server on http://localhost:4320
# or, for production:
npm run build
npm run start    # serves on port 4320
```

Point a browser at `http://localhost:4320`. With `REINS_AUTH=on`, sign up for a workspace at
`/signup`; with auth off, it is a single open board.

> Self-hosting the dashboard anywhere (Vercel, a Node host, a container) is the same: set `REINS_URL`
> to wherever your backend is reachable, then `next build` + `next start`.

---

## 6. The capture hook (CLI)

The hook is what feeds Reins. It runs inside a teammate's coding agent and posts their prompts,
agent turns, file edits and test runs. It is shipped as the `reins-hook` npm package (the `cli/`
directory) -- no clone needed on a teammate's machine.

### Set up

In the repo you code in (the project's **Connect** page shows this command with your URL):

```bash
npx reins-hook --url https://reins.yourco.com --project <id>
```

The wizard finds the repo, checks `/health`, asks which agents to wire, signs you in through the
browser (you approve `<url>/cli?code=XXXX-XXXX` while signed in; the terminal receives its own
ingest token), writes each agent's config, registers the Reins MCP tools, and says hello so the
board shows you. In Claude Code, run `/hooks` once to approve the hooks (or restart it). On a server
with auth off there is no sign-in; you pick or name a project instead. Re-run it after upgrading
reins-hook so new hooks get wired.

For CI and scripts, `npx reins-hook install --agent claude-code --url <url> --project <id> --token
rk_ingest_...` writes the same configs without prompts. Other commands: `npx reins-hook status` and
`npx reins-hook uninstall [--all]`. See [`cli/README.md`](cli/README.md) for every flag.

### What it does

- Copies the hook core to `~/.reins/` (the hook script, a shared `lib/`, agent `adapters/` and the
  MCP server) and saves the connection in `~/.reins/config.json` (mode `0600`), keyed by repo.
- **Merges** the hook into your agent settings without touching your other hooks (idempotent):
  - Claude Code, this repo (default): `./.claude/settings.local.json`; all repos: `~/.claude/settings.json`
  - Codex, OpenCode, Aider: their global config (see [`hooks/README.md`](hooks/README.md))
- The commands it writes carry no token or URL; they resolve both from `~/.reins/config.json` at
  runtime.

### What it sends

On each `UserPromptSubmit` (intent) and `Stop` (summary), the hook posts to `POST /api/ingest` with
`{ project, member, kind, text, session, source, branch, worktree, repo_root, ... }`, with git state
(branch, short HEAD, dirty files) in `meta.git`. Secrets are redacted and text is capped before
sending. After an edit tool runs it posts the repo-relative path to `POST /api/hook/touch`; after a
Bash test command (`npm test`, `pytest`, `go test`, …) it posts the command and whether it passed to
`POST /api/hook/run`. It also reads `POST /api/hook/pack` (the team pack injected at `SessionStart`,
and deltas on `UserPromptSubmit`) and `POST /api/hook/check` (the pre-edit collision warning). These
hook endpoints accept the same ingest token, scoped to its workspace, and answer without calling the
model. The member it reports as comes from the browser sign-in, which links activity to that
person's account.

See [`hooks/README.md`](hooks/README.md) for adapter details for non-Claude agents.

---

## 7. MCP: let agents read and write the board

The hook *sends* activity. MCP lets an agent *read* the shared board and *act on it*: see its items
and the questions waiting for it, add items, tick steps, ask a teammate's agent, hand work over, post
notes. There are two MCP servers; pick based on where the agent runs.

### 7a. HTTP MCP -- for any teammate, anywhere (recommended)

Runs anywhere and talks to your backend over the network (the Agent API under `/api/agent/*`, with
the ingest token from the browser sign-in). No repo clone, no database access. It ships inside the
same `reins-hook` package, and **setup registers it for you**: `mcpServers.reins` in
`~/.claude.json` for Claude Code, `[mcp_servers.reins]` in `~/.codex/config.toml` for Codex, and
`mcp.reins` in `~/.config/opencode/opencode.json` for OpenCode. The registered command is
`node ~/.reins/reins-mcp.mjs` and carries no token: it reads `~/.reins/config.json` for the folder
the agent runs in, worktrees included.

Any other MCP client can launch it with:

```bash
npx reins-hook mcp [--url <backend-url> --token <ingest-token> --project <id> --member <name>]
```

The flags override what is saved. Tools: `reins_context`, `reins_my_items`, `reins_item_add`,
`reins_step_done`, `reins_step_add`, `reins_item_status`, `reins_ask`, `reins_answer`,
`reins_handover`, `reins_note`, `reins_attach`. It is dependency-free (Node built-ins only).

Older setups keep working: passing an `rk_access_...` `--token` (optionally with
`--ingest-token rk_ingest_...` for `reins_note`) selects the previous tool set listed below.

### 7b. Local MCP -- for an agent running on the server box

Reads the SQLite file directly and calls the backend for writes. Use this only when the agent runs on
the same machine as the server (and the repo is present). Register it by pointing at the repo:

```json
{
  "mcpServers": {
    "reins": {
      "command": "npx",
      "args": ["tsx", "server/src/mcp.ts"],
      "cwd": "/ABSOLUTE/PATH/to/reins"
    }
  }
}
```

Or run it standalone from the repo: `npm run mcp` (i.e. `npx tsx server/src/mcp.ts`). Because it opens
the database file, it needs the same `REINS_DB` and (for write-back) `REINS_URL` environment the server
uses. The HTTP MCP above is the right choice for everyone else.

### Previous tool set (local MCP, and the HTTP MCP with an access token)

Reads: `reins_context`, `reins_projects`, `reins_member`, `reins_pending`, `reins_handoffs`,
`reins_goals`, `reins_profile`. Writes: `reins_note`, `reins_claim`, `reins_resolve`,
`reins_handoff_ack`, `reins_goal_add`, `reins_goal_check`.

---

## 8. Auth and tokens

Reins has two modes, set by `REINS_AUTH`:

- **`off` (local dev):** a single open instance. No accounts, no tokens. If you set
  `REINS_INGEST_KEY`, the hook must send it as `x-reins-key`; otherwise ingest is open. Good for trying
  it on one machine.
- **`on` (shared / production):** multi-tenant. People sign up for a **workspace** (the tenant
  boundary), log in with email + password, and invite teammates with a one-time link. Roles are owner,
  admin, member. This requires `REINS_SESSION_SECRET` (generate with `openssl rand -hex 32`).

### Token kinds

When auth is on, machines authenticate with tokens minted from the dashboard (or the admin CLI):

| Kind | Used by | How it is sent |
|---|---|---|
| **ingest** | the capture hook and the Reins MCP tools (each terminal gets one at sign-in) | `x-reins-key` or `Authorization: Bearer` |
| **access** | viewers, the HTTP MCP reads/writes | `Authorization: Bearer` |
| **admin** | minting and revoking tokens | `Authorization: Bearer` |

Admin CLI commands (`npm run admin -- <cmd>` from `server/`): `create-workspace`, `claim-workspace`,
`reset-link`, `list-workspaces`, `revoke`.

### CORS

If the dashboard is on a different origin from the backend **and** you use direct mode
(`NEXT_PUBLIC_REINS_URL`), set `REINS_CORS_ORIGIN` to the dashboard's origin (comma-separated for
several). With the default same-origin rewrite, you do not need this. When it is empty, the backend
allows no cross-origin browser access at all.

### Client IPs behind a proxy (`REINS_TRUST_PROXY`)

Signup and login are rate-limited per client IP. By default the server uses the socket address and
ignores `X-Forwarded-For`, which is right when clients connect to it directly (the header is
spoofable). Behind proxies, every request would otherwise share the proxy's IP, so set
`REINS_TRUST_PROXY` to the number of proxies in front of the server: for example `2` for the Vercel
rewrite plus Caddy, or `1` for Caddy alone. It also accepts Express values such as `loopback` or a
comma-separated list of trusted addresses. Don't set it higher than the real number of hops.

---

## 9. Putting it together: a full local setup

```bash
# 0) clone + install
git clone https://github.com/aruntemme/reins.git
cd reins
npm run install:all

# 1) configure the backend (set your AI provider)
cp server/.env.example server/.env
#   edit REINS_LLM_BASE_URL / REINS_LLM_API_KEY / REINS_LLM_MODEL

# 2) run backend + dashboard together
npm run dev
#   backend   on http://localhost:4319
#   dashboard on http://localhost:4320

# 3) (optional) populate a demo board without wiring agents
npm run seed

# 4) connect your agents (in any repo you code in); this also registers the Reins MCP tools
npx reins-hook --url http://localhost:4319 --project <id>
#   then run /hooks in Claude Code to approve
```

`npm run dev` at the repo root runs the server and the dashboard in parallel. Now code as usual: every
prompt, agent turn, file edit and test run flows into Reins, the dashboard updates live, and your
agents can read and act on the board through the Reins tools.

---

## 10. Production notes

For a shared team instance:

1. **Turn auth on.** Set `REINS_AUTH=on` and `REINS_SESSION_SECRET`. Mint ingest/access tokens from
   the dashboard.
2. **Persist the database.** Put `REINS_DB` on a disk that survives restarts (a Docker volume, a
   mounted disk). Back it up (see [section 4](#4-database-sqlite)).
3. **Run the backend as a service.** Docker (`server/Dockerfile`), or a process manager. The image
   defaults `REINS_DB` to `/data/reins.db`; mount a volume there.
4. **Host the dashboard** anywhere Next.js runs (Vercel, a container, a Node host) with `REINS_URL`
   pointing at the backend.
5. **TLS / domain:** front the backend with Caddy, Cloudflare, or a load balancer and keep port 4319
   closed to the internet. The dashboard rewrite, hooks, and the HTTP MCP all carry tokens and
   session cookies, so they should only travel over HTTPS. Then set `REINS_TRUST_PROXY` (see
   [section 8](#client-ips-behind-a-proxy-reins_trust_proxy)).
6. **Shutdown and health:** the server drains on `SIGTERM` (in-flight distills finish, up to
   `REINS_SHUTDOWN_GRACE_MS`; anything still queued is re-queued on the next start). `/health` checks
   the database, and the Docker image has a `HEALTHCHECK`.

The maintainer's concrete Lightsail + Vercel recipe, including provisioning and on-box CI/CD, is in
[`deploy/DEPLOY.md`](deploy/DEPLOY.md). For HA / multi-instance, the SQLite layer in `server/src/db.ts`
is small enough to swap for Postgres.

---

## 11. Full environment variable reference

All backend config is environment variables, read from `server/.env` (and the process environment,
which overrides the file). `server/.env.example` ships the common ones; this is the complete list.

### Core

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `4319` | HTTP port the backend listens on. |
| `REINS_DB` | `./reins.db` | SQLite file path. Docker uses `/data/reins.db`. |
| `REINS_URL` | `http://localhost:${PORT}` | The backend's own public URL. Used by the local MCP to call back for writes. |

### Auth

| Var | Default | Purpose |
|---|---|---|
| `REINS_AUTH` | `off` | `on` enables workspaces + tokens; `off` is a single open instance. |
| `REINS_SESSION_SECRET` | (required if auth on) | Signs dashboard sessions. `openssl rand -hex 32`. |
| `REINS_COOKIE_SECURE` | `auto` | Session cookie Secure flag: `auto` (prod only) \| `on` \| `off`. |
| `REINS_CORS_ORIGIN` | (empty) | Comma-separated dashboard origins for credentialed CORS. Empty = no cross-origin access. |
| `REINS_TRUST_PROXY` | (off) | Proxy hops to trust for the client IP used by login/signup limits, e.g. `2` for Vercel + Caddy. See [section 8](#client-ips-behind-a-proxy-reins_trust_proxy). |
| `REINS_INGEST_KEY` | (empty) | Legacy shared ingest key, honored only when `REINS_AUTH=off`. |
| `REINS_SECRET_KEY` | (auto) | Master key for encrypting model-provider API keys at rest (AES-256-GCM). Auto-generated into `.reins-secret` if unset. |

### Inference (LLM)

Providers are normally configured in the dashboard (**Settings -> model providers**) and stored
encrypted in the database. These env vars are the fallback used when no provider is configured there.

| Var | Default | Purpose |
|---|---|---|
| `REINS_LLM_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible endpoint. |
| `REINS_LLM_API_KEY` | (empty) | API key for the endpoint (any non-empty string for local servers). |
| `REINS_LLM_MODEL` | `gpt-4o` | Main model: extract, reconcile, rollup. |
| `REINS_LLM_MODEL_FAST` | falls back to `REINS_LLM_MODEL` | Cheaper model for the triage gate. |
| `REINS_LLM_MAX_TOKENS` | `2000` | Per-request output cap. |
| `REINS_LLM_TIMEOUT_MS` | `180000` | Hard per-request timeout, so a hung gateway fails fast. |

### Pipeline

| Var | Default | Purpose |
|---|---|---|
| `REINS_DISTILL_CONCURRENCY` | `1` | Concurrent distillation jobs. `1` = strictly serial (safe for rate-limited gateways). |
| `REINS_PIPELINE_MODE` | `combined` | Pipeline shape. `combined` does triage/extract/reconcile in one call. |
| `REINS_ROLLUP_MIN_INTERVAL_MS` | `60000` | Minimum time between automatic rollups per project (a trailing run catches up). |
| `REINS_EVENT_RETENTION_DAYS` | `30` | Raw captured event text older than this is blanked by the hourly cleanup; distilled state is kept. `0` keeps it forever. |
| `REINS_SHUTDOWN_GRACE_MS` | `8000` | How long `SIGTERM` waits for running distills before exiting. |
| `REINS_TOUCH_WINDOW_MS` | `1800000` | How long a real file edit counts toward collisions and the pre-edit warning (30 min). |
| `REINS_COLLISION_SWEEP_MS` | `120000` | How often open collision/blocker handoffs are re-checked, so they auto-close when an overlap ends by time. |

### Integrations

| Var | Default | Purpose |
|---|---|---|
| `REINS_SLACK_WEBHOOK` | (empty) | Post a digest to Slack on each team rollup. Instance-wide, so only rollups of the `default` workspace (or any rollup when auth is off) are posted. |
| `REINS_DISCORD_WEBHOOK` | (empty) | Same, for Discord. |

### Frontend (web)

| Var | Default | Purpose |
|---|---|---|
| `REINS_URL` | `http://localhost:4319` | Backend the dashboard proxies `/api/*` to. |
| `NEXT_PUBLIC_REINS_URL` | (unset) | Optional direct SSE mode; needs backend `REINS_CORS_ORIGIN`. |

---

## 12. Troubleshooting

- **Events arrive but never distill.** No inference backend is configured, or the model/endpoint is
  wrong. Check the server's boot banner (it prints the inferred backend or `NOT CONFIGURED`) and that
  `REINS_LLM_*` are set. Raw capture still works without inference; only the status summaries need it.
- **Distillation stalls under load.** A rate-limited gateway can hang requests. Keep
  `REINS_DISTILL_CONCURRENCY=1` (the default, serial) and confirm `REINS_LLM_TIMEOUT_MS` is set so
  hung calls fail fast instead of wedging the queue.
- **Hook posts nothing.** Confirm you approved it with `/hooks`, that the server is reachable
  (`curl <url>/health`), and run `npx reins-hook status` to see the saved sign-in, the repo's project
  and which agents are wired. Re-running `npx reins-hook` fixes a stale or revoked sign-in.
- **Test runs don't show.** They need reins-hook 0.2.0 or later; re-run `npx reins-hook` after
  upgrading so the Bash hooks get wired, then approve them with `/hooks`.
- **Reins tools missing in the agent.** Re-run setup, then restart the agent. Other MCP clients use
  `npx reins-hook mcp`; with older flags, an `rk_access_...` `--token` reads and `--ingest-token`
  lets `reins_note` write.
- **Dashboard shows nothing / SSE errors.** Check `REINS_URL` points at the backend. If you opted into
  `NEXT_PUBLIC_REINS_URL` direct mode, the backend's `REINS_CORS_ORIGIN` must include the dashboard's
  origin.
- **Database locked / missing.** Make sure only one server process writes the file, and that
  `REINS_DB`'s directory exists and is writable. The `-wal` and `-shm` companion files are normal.
