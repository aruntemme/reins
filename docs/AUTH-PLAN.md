# Real accounts on top of workspaces

Goal: anyone can sign up with email + password. Signup creates a personal workspace. They log in,
create or import projects, connect agents, and invite teammates by link. The existing workspace +
token model stays underneath: tokens become machine credentials (hooks, agents, MCP), and human
access now comes from a logged-in account.

Decisions (made): email + password login. One workspace per signup, with link-based invites and
multi-workspace membership. No email provider in v1, so verification, password reset, and invites all
work through one-time shareable links instead of email.

## What exists today (build on, do not replace)

- `workspaces` and `tokens` (ingest / access / admin, sha256-hashed) in `server/src/db.ts` + `auth.ts`.
- Stateless HMAC session cookie `reins_sess` carrying `{ ws, kind }` (`signSession` / `verifySession`).
- `routes/auth.ts`: token-to-session, `/auth/me`, `/auth/logout`, admin token + invite (token-minting) + workspace endpoints.
- `middleware.ts`: `requireIngest` / `requireViewer` / `requireAdmin`, `authorizeProject`, `req.workspaceId`.
- Web `/signin` pastes an access token; dashboard guards on `api.me()`.

The gap: there is no `users` concept, no password, no self-serve signup, and workspaces are created
only by the admin CLI. We add the human-identity layer above the workspace layer.

## Data model (new tables, all additive, `CREATE TABLE IF NOT EXISTS`)

```
users           id, email (unique, lowercased), password_hash, created_at, last_login
memberships     user_id, workspace_id, role (owner|admin|member), created_at   PK(user_id, workspace_id)
invites         id, workspace_id, role, code_hash (sha256 of a one-time code), label,
                created_by, expires_at, accepted_by, accepted_at, created_at
password_resets id, user_id, code_hash, expires_at, used_at, created_at
```

- `tokens` is unchanged in shape but repurposed: machine credentials per workspace (hooks/agents/MCP).
- Roles: `owner` (created the workspace; can delete it, manage members and tokens), `admin` (manage
  members, tokens, projects), `member` (view and act on projects). Maps cleanly onto the existing
  `requireViewer` / `requireAdmin` gates.

## Password hashing

Node built-in `crypto.scryptSync` with a 16-byte random salt, stored as `scrypt$N$salt$hash`;
verify with `timingSafeEqual`. No new dependency. (argon2id is an option later via a native dep; scrypt
is strong and dependency-free, which keeps `npx`/CI simple.)

## Sessions

Keep the stateless signed cookie, extend the payload to `{ uid, ws, role, iat }`. `verifySession`
returns `{ userId, workspaceId, role }`. A user with several workspaces has one active workspace in the
cookie; switching re-signs the cookie after validating membership. Token-paste sessions still work
(payload `{ ws, kind }`, no `uid`) for agents, the demo, and back-compat.

## Endpoints

Human auth (new):
- `POST /api/auth/signup {email, password, workspaceName?}` -> create user, create workspace, owner
  membership, mint the workspace's default tokens (ingest + access + admin, shown once), set session.
- `POST /api/auth/login {email, password}` -> verify, set session to the user's primary workspace.
- `GET  /api/auth/me` -> `{ auth, user:{email}, workspace (active), workspaces:[{id,name,role}], admin }`.
- `POST /api/auth/logout` (exists).
- `POST /api/auth/switch {workspaceId}` -> validate membership, re-sign cookie.

Members and invites (link-based, owner/admin):
- `POST /api/workspaces/:id/invites {role, label?}` -> returns a one-time URL `/join?code=...`.
- `POST /api/auth/join {code}` -> requires a logged-in user; adds membership, marks the invite accepted.
- `GET  /api/workspaces/:id/members`, `POST .../members/:userId/role`, `DELETE .../members/:userId`.

Reset without email (v1):
- `reins admin reset-link <email>` (CLI, owner of the box) prints a one-time `/reset?code=...` link.
- `POST /api/auth/reset {code, password}` -> set new password. Self-service "forgot password" lands
  when an email provider is wired (documented as the v2 follow-up).

Projects ("import"):
- `POST /api/projects {id, name}` -> create an empty project in the active workspace; the UI then shows
  the one-line `npx reins-hook install ... --project <id> --token <ingest>` to connect agents.
- Auto-create on first ingest stays (scoped to the token's workspace).
- `reins admin claim-workspace <workspaceId> <email>` (CLI) attaches an existing workspace (for example
  the live "My Team") to a real account as owner, so current data migrates cleanly.

## Authorization changes

- `requireViewer`: accept a user session (membership in `ws`) OR an access/admin token.
- `requireAdmin`: accept a user session with role `owner|admin` OR an admin token.
- `requireIngest`: unchanged (tokens only; agents do not log in).
- `authorizeProject`: unchanged logic; `req.workspaceId` now comes from the user's active workspace.

## Frontend

- `/signup`: email + password (+ confirm) and an optional workspace name. On success, redirect to the
  dashboard and show "connect your first agent" with the install command. (The user types their own
  credentials; the app never autofills them.)
- `/login`: email + password. Keep token-paste as an "advanced / agent token" affordance and keep the
  public demo button.
- Top bar: workspace switcher when the user has more than one.
- Settings: members (invite by link, change role, remove), tokens (reuse the existing manage/revoke UI),
  workspace name and delete.
- Project create/import UI with the scoped install command (reuse `CopyCommand`, `Invite`).
- Guards: dashboard requires a session and redirects to `/login`.

## Security

- scrypt + timing-safe compare; never store or log plaintext; tokens stay hashed.
- `REINS_SESSION_SECRET` must be set and stable in production (already used); httpOnly, SameSite=Lax,
  Secure in prod (already handled).
- CSRF: same-origin via the Vercel `/api` proxy plus SameSite=Lax covers v1; add a double-submit token
  for cross-origin hardening as a follow-up.
- Basic in-memory rate limiting / backoff on login and signup per IP; note a real limiter for scale.
- Password policy (min length, reject common); normalized unique email; failed-login backoff.
- Open public signup means abuse surface: rate limit now, add email verification or a captcha when the
  email provider lands (v2).

## Migration and back-compat

- New tables are additive; existing tokens and the token-paste flow keep working.
- The live "My Team" workspace gets an owner via `claim-workspace`, so existing boards stay intact under
  a real login.
- Turning this on changes the live `/signin` UX to login/signup; the demo access-token button stays.

## Build plan (waves, parallelizable in worktrees)

- Phase 0 (seams, blocking): the four tables + `auth.ts` helpers (createUser, verifyPassword,
  addMembership, listMemberships, createInvite/acceptInvite) + extended session payload. Real unit tests.
- Phase 1 (parallel worktrees):
  - Backend: signup / login / switch / invites / join / reset routes + middleware role updates.
  - Frontend: signup + login pages, guards, workspace switcher.
  - Members + settings UI (on top of the existing token UI).
  - Project create/import UI.
  - Admin CLI: claim-workspace, reset-link.
- Phase 2: claim the live workspace, set the session secret, redeploy (frontend auto, backend manual).

Each phase: real tests (password hash/verify, session round-trip, full HTTP signup -> login -> invite ->
join -> role enforcement against a real server child + temp DB), typecheck, then PRs, same as the last wave.

## Open defaults (sensible, change if you want)

- Workspace name on signup defaults to "<email local-part>'s workspace" if left blank.
- Password minimum length 10.
- Invite and reset links expire after 7 days, single use.
- Signup is open to anyone (the whole point); rate-limited.
