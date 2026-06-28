# Reins: build-out plan for the remaining features

This is the working plan for everything still open after the live launch. It is
written so the workstreams can run side by side in separate git worktrees with
the least possible collision. Read the "Shared seams" section first: a few small
contracts have to land on `main` before the parallel work starts, otherwise the
worktrees will fight over the same files.

Repo root: `/Users/temme/learning/reins`. Current branch: `main` (live,
auto-deploys).

## What is already shipped (do not rebuild)

Capture (Claude Code hook) to distillation on any OpenAI-compatible provider to
per-person status and team rollup, auto handoffs and @mentions, live SSE
dashboard, MCP read and write tools, multi-tenant auth (workspaces and tokens),
admin invite flow, Vercel plus Lightsail deploy on HTTPS.

The MCP write tools (`reins_claim`, `reins_resolve`, `reins_handoff_ack`,
`reins_note`) already exist. The ingest pipeline is generic
(`project / member / kind / text / meta`), so a new harness is mostly a new
capture client, not server work.

## The six workstreams

| ID | Workstream | Size | Depends on | Worktree branch |
|----|------------|------|------------|-----------------|
| S0 | Shared seams (source attribution + capture core) | small | none | `feat/seams` (lands on main first) |
| A | More agent harnesses (Codex, opencode, pi, Hermes, Koda) | large | S0 | `feat/harnesses` |
| B | Autonomous claimer (agents act on context) | medium | S0 | `feat/auto-agent` |
| E | Smarter retrieval (rank and trim context) | medium | none | `feat/retrieval` |
| F | Slack / Discord digests | small | none | `feat/digests` |
| G | Token revocation UI + workspace cleanup | small | none | `feat/admin-revoke` |

## Phase 0: shared seams (must land on main before fan-out)

These are tiny but everything else assumes them. One short PR on `main`.

1. **Source attribution on every event.** Add an optional `source` field to
   `IngestInput` and persist it (`events.source`, default `"claude-code"`). The
   capture clients in S0 set it to `codex`, `opencode`, `pi`, etc. This is the
   only schema change harnesses need, so it must exist before A and B start.
   - Files: `server/src/pipeline/index.ts`, `server/src/db.ts` (column + migration),
     `server/src/routes/api.ts` (pass through), `server/src/state.ts` (surface in views).

2. **Capture-client core extraction.** Pull the POST-to-`/api/ingest` logic out of
   `cli/reins-hook.mjs` into `cli/lib/capture.mjs` (read payload, derive member,
   truncate, fire-and-forget with timeout). The Claude Code hook becomes a thin
   adapter over it. A then adds one adapter file per harness against the same core.
   - Files: `cli/lib/capture.mjs` (new), `cli/reins-hook.mjs` (refactor to use it).

Acceptance for Phase 0: existing Claude Code capture still works end to end
(ingest returns 200 with eventId, dashboard updates) and `events.source` shows
`claude-code`.

## Workstream detail

### A. More agent harnesses  (`feat/harnesses`)

**Why.** The landing page greys out Codex, pi, Hermes, Koda, OpenCode as "coming
soon". This proves the "mixed tools, one shared context" claim.

**How.** Each harness has a different capture surface. Build one adapter per tool
on top of `cli/lib/capture.mjs`, plus install docs.
- **opencode / Codex / Aider**: most expose a hooks or events config similar to
  Claude Code. Adapter parses that payload shape into the common
  `{ kind, text, session }` and calls the core with `source` set.
- **pi / Koda / Hermes**: where there is no native hook, ship a thin wrapper or a
  log tailer that maps tool output to intent/progress/summary.
- Extend `npx reins-hook install` with a `--agent <name>` flag that writes the
  right config for the chosen harness.
- Flip the matching tile in `web/components/tools.tsx` from "coming soon" to live
  as each adapter ships.

**Files.** `cli/adapters/*.mjs` (new), `cli/bin.mjs` (flag), `hooks/README.md`,
`web/components/tools.tsx`. No server changes beyond S0.

**Acceptance.** For each shipped harness: run a real session, see an event with
the correct `source` land on the dashboard and in the MCP context. No stubs.

### B. Autonomous claimer  (`feat/auto-agent`)

**Why.** Today claim/resolve are human button clicks. The MCP write path exists;
nothing drives it automatically.

**How.** A small standalone loop, `agent/reins-agent.mjs`, that authenticates with
an ingest+access token, polls `reins_pending` (or `GET /api/projects/:id`), and
for items matching a policy calls `reins_claim` then works and `reins_resolve`.
Start with a dry-run mode that only logs what it would claim. Add a `source:
"auto"` tag so autonomous actions are visible in the timeline.
- Also covers the "sub-agents and loops" roadmap item: the same client is what a
  parent agent or an autonomous loop calls to keep context updating with no human.

**Files.** `agent/` (new package), optionally a read-only `GET /api/pending`
convenience endpoint in `server/src/routes/api.ts`. Disjoint from A.

**Acceptance.** Dry-run prints real pending items from live. With a policy enabled
against a test project, an item moves open to claimed to done with `source: auto`,
visible live. No fake data.

### E. Smarter retrieval  (`feat/retrieval`)

**Why.** `reins_context` returns the whole pack. An agent should pull only what is
relevant to its task.

**How.** Add optional params to `reins_context` / the pack builder: `member`,
`query`, `limit`. Rank timeline and pending entries by recency and overlap with
the query (start with simple lexical scoring, leave room for embeddings later),
trim to a token budget.

**Files.** `server/src/context-pack.ts`, `server/src/mcp.ts`. Disjoint from the
other workstreams.

**Acceptance.** Same project, a scoped query returns a materially smaller, on-topic
pack than the full one, measured by token count.

### F. Slack / Discord digests  (`feat/digests`)

**Why.** Humans who just want a glance.

**How.** New `server/src/integrations/digest.ts` that formats a rollup and posts to
a configured webhook. Trigger on the existing debounced rollup completion (hook in
`server/src/pipeline/rollup.ts`) and/or a daily timer. Webhook URL per workspace,
stored like other config, gated by env.

**Files.** `server/src/integrations/` (new), one call site in
`server/src/pipeline/rollup.ts`. Disjoint from everything else.

**Acceptance.** A real rollup posts a formatted message to a test Slack and
Discord webhook.

### G. Token revocation UI + workspace cleanup  (`feat/admin-revoke`)

**Why.** Invite mints tokens but revoke is CLI only. Two duplicate "My Team"
workspaces exist live from the earlier volume reset.

**How.** Add `GET /api/admin/tokens` (list, masked) and `POST /api/admin/tokens/:id/revoke`
in `server/src/routes/auth.ts` + `server/src/admin.ts`. Add a small admin panel in
the dashboard (reuse the `Invite` admin gate). Separately, a one-off script to
merge or delete the duplicate live workspace.

**Files.** `server/src/admin.ts`, `server/src/routes/auth.ts`, `web/lib/api.ts`,
`web/components/invite.tsx` or a new `web/components/admin.tsx`. Disjoint.

**Acceptance.** Admin lists tokens, revokes one, the revoked token then fails auth.
Live shows a single "My Team" workspace.

## File-collision matrix (why the split is safe)

| File | S0 | A | B | E | F | G |
|------|----|---|---|---|---|---|
| `pipeline/index.ts` | w | | | | | |
| `db.ts` | w | | | | | |
| `routes/api.ts` | w | | r/w | | | |
| `state.ts` | w | | | | | |
| `cli/lib/capture.mjs` | w | r | | | | |
| `cli/adapters/*`, `bin.mjs` | | w | | | | |
| `web/components/tools.tsx` | | w | | | | |
| `agent/*` | | | w | | | |
| `context-pack.ts` | w | | | w | | |
| `mcp.ts` | | | | w | | |
| `pipeline/rollup.ts` | | | | | w | |
| `integrations/*` | | | | | w | |
| `routes/auth.ts`, `admin.ts` | | | | | | w |
| `web/lib/api.ts` | | r/w | | | | r/w |

Every workstream touches a disjoint set of files (S0 lands first on `main`), so
they all run fully parallel.

## Execution waves

- **Wave 0:** S0 on `main` (one short PR). Blocks A and B.
- **Wave 1 (parallel worktrees):** A, B, E, F, G all start at once off
  post-S0 `main`. These touch disjoint files.
- **Wave 2:** integration pass on `main`, then deploy.

Each worktree:

```bash
cd /Users/temme/learning/reins
git worktree add ../reins-harnesses feat/harnesses
git worktree add ../reins-auto-agent feat/auto-agent
git worktree add ../reins-retrieval feat/retrieval
# ...one per workstream
```

Each gets its own `npm install` and its own dev server on a distinct port to test
in isolation, then a PR with a proper title and description per the repo
convention.

## Integration and verification

- Every workstream uses real runs, no stubs: real harness sessions (A), real
  pending transitions on live (B), a real scoped retrieval comparison (E), real
  webhook posts (F).
- Merge order: S0 first, then the rest in any order (they are disjoint).
- After all merges land on `main`, redeploy the Lightsail backend
  (`docker compose up -d --build`) and let Vercel auto-deploy the frontend, then
  run the end-to-end check (capture to dashboard to MCP pull) once more.
- Update `README.md` "What works today" and trim "Roadmap" as items ship.
