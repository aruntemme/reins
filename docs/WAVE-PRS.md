# Wave PRs

Seven feature branches plus the seam base, all branched from `main` and integrated on `wave/base`.
Each was built in its own git worktree, then independently re-verified by an adversarial agent
(re-ran tests, typechecked, scanned the diff for stubs) before merge. All tests are real: local HTTP
receivers, temp SQLite DBs, child-process servers, and real 0G testnet calls. No stubs or mocks of the
unit under test.

Merge order on `wave/base`: S0 -> C -> G -> D -> F -> B -> A -> E, all clean (only `db.ts`, `env.ts`,
`rollup.ts` were touched by more than one branch; git auto-merged every one).

Suite on `wave/base`: 34 server tests pass + 2 honest skips (the live-0G tests, which run with
`OG_STORAGE=on`), 25 CLI tests pass, server + web typecheck clean, MCP boots with 12 tools, and a live
end-to-end run (real ingest -> openadapter distillation -> rollup) passes.

Recommended: one PR per branch in the order below. A single squashed "wave" PR is also fine; the
per-branch split keeps review focused.

---

## S0 — shared seams (base for everything)
Branch: folded into `wave/base` (commits `d16d01e`, `679691e`)
Title: **Shared seams: source attribution, snapshot ledger, capture core**

Adds the small contracts the rest of the wave builds on:
- `events.source` column (+ migration) attributing each event to the agent that captured it; threaded
  through `IngestInput`, `POST /api/ingest`, and member detail.
- An append-only `snapshots` ledger (`recordSnapshot`/`listSnapshots`/`latestSnapshot`/`setSnapshotAnchor`)
  recording every 0G Storage context-pack write; the rollup push now writes to it.
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

## C — cross-instance sync over 0G Storage
Branch: `feat/og-sync`
Title: **Cross-instance context sync over 0G Storage**

- `server/src/sync.ts`: `mergePack` (pure, idempotent merge), `syncPush` (build pack -> 0G Storage ->
  ledger), `syncPull` (fetch by root hash -> merge). `db.ts` gains `upsertMemberState`.
- MCP tools `reins_sync_push` and `reins_sync_pull`: two instances share context by handing over a hash.
- Tests: pure merge + idempotency; a REAL 0G round-trip (push returns a Merkle root, a second DB pulls and
  reconstructs the project), gated on `OG_STORAGE=on` + a funded wallet.

---

## D — on-chain anchoring on 0G Chain
Branch: `feat/og-anchor`
Title: **On-chain anchoring: commit snapshot root hashes to 0G Chain**

- `server/src/llm/og-chain.ts`: `anchorRootHash` sends a minimal self-transaction whose calldata commits
  `reins:<rootHash>`, records the tx on the ledger row, and exposes `anchorStats`. Env gate `OG_ANCHOR`.
- Wired (fire-and-forget) into the rollup push; surfaced in `GET /api/og/status` as an `anchor` block.
- Tests: calldata encode/decode round-trip; a REAL testnet anchor tx (asserts chainId 16602 and that the
  ledger row records the broadcast tx hash), gated on `OG_STORAGE=on` + a funded wallet.

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
  keeping the goal and rollup. `buildContextPack` unchanged (back-compat; the 0G write path is untouched).
- `mcp.ts`: `reins_context` takes optional `member` / `query` / `limit`, applied in-memory on both the
  local and 0G-storage read paths (full pack still Merkle-verified before trimming).
- Tests: `scoreRelevance` units; scoped ranking + trimming; back-compat; scoped render is smaller than full.
