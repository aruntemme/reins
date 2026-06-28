# Wave PRs

Seven feature branches plus the seam base, all branched from `main` and integrated on `wave/base`.
Each was built in its own git worktree, then independently re-verified by an adversarial agent
(re-ran tests, typechecked, scanned the diff for stubs) before merge. All tests are real: local HTTP
receivers, temp SQLite DBs, and child-process servers. No stubs or mocks of the unit under test.

Merge order on `wave/base`: S0 -> G -> F -> B -> A -> E, all clean (only `db.ts`, `env.ts`,
`rollup.ts` were touched by more than one branch; git auto-merged every one).

Suite on `wave/base`: server tests pass, 25 CLI tests pass, server + web typecheck clean, MCP boots,
and a live end-to-end run (real ingest -> openadapter distillation -> rollup) passes.

Recommended: one PR per branch in the order below. A single squashed "wave" PR is also fine; the
per-branch split keeps review focused.

---

## S0 — shared seams (base for everything)
Branch: folded into `wave/base` (commits `d16d01e`, `679691e`)
Title: **Shared seams: source attribution, capture core**

Adds the small contracts the rest of the wave builds on:
- `events.source` column (+ migration) attributing each event to the agent that captured it; threaded
  through `IngestInput`, `POST /api/ingest`, and member detail.
- Reusable capture core `cli/lib/capture.mjs` (`resolveMember`, `lastAssistantText`, `sendEvent`);
  `reins-hook.mjs` becomes a thin Claude Code adapter over it.
- Server + CLI test scripts (`node:test` via tsx).

---

## A — more agent harnesses
Branch: `feat/harnesses`
Title: **Bring your own agent: Codex, OpenCode, Aider, and a generic adapter**

- `cli/adapters/` thin adapters over the capture core: `generic.mjs` (any shell-hook agent),
  `codex.mjs`, `opencode.mjs`, `aider.mjs`, with pure exported mapping functions.
- `reins-hook install --agent <name> --source <id>` writes the right hook config and copies the adapters
  into `~/.reins`, without clobbering foreign hooks. Claude Code stays the default.
- `web/components/tools.tsx`: Codex and OpenCode flipped to live (concrete tested adapters); pi, Hermes,
  Koda stay "coming soon" honestly (generic + MCP note path documented).
- `hooks/README.md` documents per-agent install + exact trigger wiring.
- Tests: adapter mapping units + e2e against a local HTTP server; install merge tests drive `bin.mjs`
  against a temp HOME. 25 CLI tests.

---

## B — autonomous claimer agent
Branch: `feat/auto-agent`
Title: **Autonomous agent: claim and resolve up-for-grabs work without a human**

- `agent/reins-agent.mjs` (built-ins only): polls open pending, claims then resolves matching items, and
  posts a `source:auto` note. Flags `--policy <regex|all> --dry-run --once --interval`; bearer auth opt-in.
- `GET /api/projects/:id/pending` convenience endpoint.
- Tests: real child-process server + temp DB; dry-run changes nothing, live run drives open -> claimed ->
  done and records a `source:auto` event; pure policy-matcher unit tests.

---

## F — Slack / Discord digests
Branch: `feat/digests`
Title: **Rollup digests to Slack and Discord**

- `server/src/integrations/digest.ts`: `formatSlack`/`formatDiscord`/`postDigest`; env-gated by
  `REINS_SLACK_WEBHOOK` / `REINS_DISCORD_WEBHOOK`; fired (fire-and-forget) after each rollup.
- Tests: payload formatting units + a real POST to a local webhook receiver for both Slack and Discord.

---

## G — token revocation UI + workspace cleanup
Branch: `feat/admin-revoke`
Title: **Admin: list and revoke tokens from the dashboard; workspace cleanup CLI**

- `web/lib/api.ts` + `web/components/admin.tsx`: admin-gated modal to list tokens and revoke them
  (inline confirm, not a blocking dialog), placed next to Invite. Backend endpoints already existed.
- `server/src/admin.ts`: `merge-workspace <from> <to>` and `delete-workspace <id>` (refuses while it owns
  projects) to clean up the duplicate live "My Team" workspace. Not run against anything live.
- Tests: real HTTP admin list + revoke (revoked token then fails `verifyToken`); db-level cleanup tests.

---

## E — smarter retrieval
Branch: `feat/retrieval`
Title: **Smarter retrieval: scope and trim reins_context**

- `context-pack.ts`: `scoreRelevance` (pure lexical overlap), `buildScopedContextPack` / `scopePack`
  rank by focused-member -> relevance -> recency and trim to an approximate token budget while always
  keeping the goal and rollup. `buildContextPack` unchanged (back-compat).
- `mcp.ts`: `reins_context` takes optional `member` / `query` / `limit`, applied in-memory before
  trimming.
- Tests: `scoreRelevance` units; scoped ranking + trimming; back-compat; scoped render is smaller than full.
