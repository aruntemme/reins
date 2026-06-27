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
                          your AI provider (OpenAI-compatible, or 0G Compute)
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
  their prompts and agent turns to `POST /api/ingest`.
- Two **MCP servers** let an agent read and write the shared board: one runs on the server box and
  reads SQLite directly, the other runs anywhere and talks to the backend over HTTP.

Everything stores into the one SQLite file. The hook and both MCP servers all reach the same data:
the hook and the HTTP MCP go through the backend's API, and the local MCP reads the database file on
the box directly (and calls the backend for writes).

---

## 2. Prerequisites

- **Node.js 22** recommended (the Docker image uses `node:22`; the CLI requires `>=18`).
- **An OpenAI-compatible inference endpoint.** Anything that speaks the OpenAI API works: OpenAI,
  OpenRouter, Together, Groq, a local vLLM, Ollama, or LM Studio, or the 0G Private Computer router.
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

Open `server/.env` and set, at minimum, your inference provider. The two common shapes:

**Any OpenAI-compatible provider (default):**

```bash
REINS_LLM_PROVIDER=openai
REINS_LLM_BASE_URL=https://api.openai.com/v1   # or OpenRouter / Ollama / vLLM / LM Studio
REINS_LLM_API_KEY=sk-...                        # any non-empty string for local servers
REINS_LLM_MODEL=gpt-4o                          # your main reasoning model
REINS_LLM_MODEL_FAST=gpt-4o-mini                # optional cheaper model for the triage gate
```

**0G Compute (via the 0G Private Computer router, OpenAI-compatible):**

```bash
REINS_LLM_PROVIDER=0g-router
OG_ROUTER_API_KEY=...
REINS_LLM_MODEL=...
OG_STORAGE=on            # optional: verifiable snapshots on 0G Storage
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
  timeline, pending items, handoffs, goals and checklist items, the team rollup, and (if 0G Storage is
  on) the snapshot ledger.

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

The hook is what feeds Reins. It runs inside a teammate's coding agent and posts their prompts and
agent turns. It is shipped as the `reins-hook` npm package (the `cli/` directory), installed with one
command -- no clone needed on a teammate's machine.

### Install

```bash
npx reins-hook install --url http://localhost:4319 --me yourname
# then run /hooks in Claude Code to approve it
```

On a shared instance with auth on, pass the ingest token from your dashboard:

```bash
npx reins-hook install --url https://reins.yourco.com --me asha --token rk_ingest_...
```

### What it does

- Copies the hook core to `~/.reins/` (the hook script, a shared `lib/`, and agent `adapters/`).
- **Merges** the hook into your agent settings without touching your other hooks (idempotent):
  - per-project (default): `./.claude/settings.local.json`
  - all repos (`--global`): `~/.claude/settings.json`

### Flags

| Flag | Default | Meaning |
|---|---|---|
| `--url <url>` | `http://localhost:4319` | Reins server |
| `--me <name>` | git email, else `$USER` | Who you are (capture identity) |
| `--project <id>` | folder name | Project scope |
| `--token <tok>` | (none) | Ingest token (required when the server has auth on) |
| `--agent <name>` | `claude-code` | Agent: `claude-code`, `codex`, `opencode`, `aider`, `generic` |
| `--global` | off | Install for all repos |

Other commands: `npx reins-hook status` and `npx reins-hook uninstall [--global]`.

### What it sends

On each `UserPromptSubmit` (intent) and `Stop` / `SubagentStop` (summary), the hook posts to
`POST /api/ingest` with `{ project, member, kind, text, source, ... }`. Secrets are redacted and text
is capped before sending. The identity (`--me`) is what links activity to a teammate account, so keep
it consistent with how that person signs in.

See [`hooks/README.md`](hooks/README.md) for adapter details for non-Claude agents.

---

## 7. MCP: let agents read and write the board

The hook *sends* activity. MCP lets an agent *read* the shared board and *act on it* (claim work,
resolve handoffs, post notes, manage goals). There are two MCP servers; pick based on where the agent
runs.

### 7a. HTTP MCP -- for any teammate, anywhere (recommended)

Runs anywhere, talks to your backend over the network with a token. No repo clone, no database access.
This is what a remote teammate uses. It ships inside the same `reins-hook` package.

```bash
claude mcp add reins -- npx reins-hook mcp --url https://your-reins --token rk_access_...
# add --ingest-token rk_ingest_... to also let the agent post notes
```

Any MCP client works; the launch command is always:

```bash
npx reins-hook mcp --url <backend-url> --token <access-token> [--ingest-token <ingest-token>]
```

- Reads and most writes authenticate with the **access token** (`Authorization: Bearer`).
- `reins_note` uses the optional **ingest token**.
- It is dependency-free (Node built-ins only), so `npx` has nothing to install.

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

### Tools both expose

Reads: `reins_context`, `reins_projects`, `reins_member`, `reins_pending`, `reins_handoffs`,
`reins_goals`, `reins_profile`. Writes: `reins_note`, `reins_claim`, `reins_resolve`,
`reins_handoff_ack`, `reins_goal_add`, `reins_goal_check`. The local MCP additionally exposes
`reins_pull_context` (rebuild a snapshot from a 0G Storage root hash alone).

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
| **ingest** | the capture hook, `reins_note` | `x-reins-key` or `Authorization: Bearer` |
| **access** | viewers, the HTTP MCP reads/writes | `Authorization: Bearer` |
| **admin** | minting and revoking tokens | `Authorization: Bearer` |

Admin CLI commands (`npm run admin -- <cmd>` from `server/`): `create-workspace`, `claim-workspace`,
`reset-link`, `list-workspaces`, `revoke`.

### CORS

If the dashboard is on a different origin from the backend **and** you use direct mode
(`NEXT_PUBLIC_REINS_URL`), set `REINS_CORS_ORIGIN` to the dashboard's origin (comma-separated for
several). With the default same-origin rewrite, you do not need this.

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

# 4) connect your agent (in any repo you code in)
npx reins-hook install --url http://localhost:4319 --me yourname
#   then run /hooks in Claude Code to approve

# 5) (optional) let your agent read/write the board over MCP
claude mcp add reins -- npx reins-hook mcp --url http://localhost:4319 --token <access-token>
```

`npm run dev` at the repo root runs the server and the dashboard in parallel. Now code as usual: every
prompt and agent turn flows into Reins, the dashboard updates live, and any agent with the MCP can pull
the shared context before it starts.

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
   pointing at the backend. The `/api/*` rewrite keeps the browser same-origin, so the backend can stay
   plain HTTP behind it.
5. **TLS / domain:** front the backend with Caddy, Cloudflare, or a load balancer if you want HTTPS
   directly on it (needed only if you use `NEXT_PUBLIC_REINS_URL` direct mode).

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
| `REINS_CORS_ORIGIN` | (empty) | Comma-separated dashboard origins for credentialed CORS. Empty = unrestricted. |
| `REINS_INGEST_KEY` | (empty) | Legacy shared ingest key, honored only when `REINS_AUTH=off`. |

### Inference (LLM)

| Var | Default | Purpose |
|---|---|---|
| `REINS_LLM_PROVIDER` | `openai` | `openai` \| `0g-router` \| `0g`. |
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

### Integrations

| Var | Default | Purpose |
|---|---|---|
| `REINS_SLACK_WEBHOOK` | (empty) | Post a digest to Slack on each team rollup. |
| `REINS_DISCORD_WEBHOOK` | (empty) | Same, for Discord. |

### 0G Compute -- Private Computer router

| Var | Default | Purpose |
|---|---|---|
| `OG_ROUTER_API_KEY` | (empty) | Router API key (manage at the 0G PC dashboard). |
| `OG_ROUTER_BASE_URL` | `https://router-api-testnet.integratenetwork.work/v1` | Router endpoint. Override for mainnet. |
| `OG_PRIVATE` | `off` | Route inference to privacy-enabled TEE providers. |
| `OG_MAX_OUTPUT` | `2048` | Output token cap for the router. |

### 0G Compute -- broker SDK (advanced)

| Var | Default | Purpose |
|---|---|---|
| `OG_PRIVATE_KEY` | (empty, else `./.0g-key`) | Chain wallet key; signs inference billing and storage uploads. |
| `OG_COMPUTE_PROVIDER` | (empty) | Pin a specific provider address; else auto-pick. |
| `OG_LEDGER_TOPUP` | `1` | Top the broker ledger up to N 0G when low (`0` = never). |

### 0G Storage and Chain

| Var | Default | Purpose |
|---|---|---|
| `OG_STORAGE` | `off` | Store verifiable, content-addressed snapshots on 0G Storage. |
| `OG_STORAGE_INDEXER` | `https://indexer-storage-testnet-turbo.0g.ai` | 0G Storage indexer. |
| `OG_STORAGE_RPC` | falls back to `OG_RPC_URL` | RPC for storage transactions. |
| `OG_RPC_URL` | `https://evmrpc-testnet.0g.ai` | 0G chain RPC. |
| `OG_ANCHOR` | `off` | Commit each snapshot's Merkle root to 0G Chain (spends gas). |
| `OG_EXPLORER` | `https://chainscan-galileo.0g.ai` | Block explorer URL (display). |
| `OG_STORAGE_EXPLORER` | `https://storagescan-galileo.0g.ai` | Storage explorer URL (display). |

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
- **Hook posts nothing.** Confirm you approved it with `/hooks`, that `--url` points at a reachable
  backend (`curl <url>/health`), and -- with auth on -- that you passed a valid ingest `--token`.
- **HTTP MCP can't read.** It needs a valid **access** token (`--token`). `reins_note` additionally
  needs an **ingest** token (`--ingest-token`). Mint both from the dashboard.
- **Dashboard shows nothing / SSE errors.** Check `REINS_URL` points at the backend. If you opted into
  `NEXT_PUBLIC_REINS_URL` direct mode, the backend's `REINS_CORS_ORIGIN` must include the dashboard's
  origin.
- **Database locked / missing.** Make sure only one server process writes the file, and that
  `REINS_DB`'s directory exists and is writable. The `-wal` and `-shm` companion files are normal.
