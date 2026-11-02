# Deploying Reins

> This is the maintainer's concrete recipe: **backend on AWS Lightsail, dashboard on Vercel**. For a
> provider-agnostic, all-the-pieces self-hosting guide (backend, database, dashboard, hook, both MCP
> servers, full env reference), see [`../SELFHOST.md`](../SELFHOST.md).

**Backend + DB → AWS Lightsail** (one small VM, Docker, persistent disk) ·
**Dashboard → Vercel** (Next.js).

The dashboard proxies `/api/*` to the backend *server-side*, so sessions stay first-party. The
backend itself is served over HTTPS by **Caddy** on the box (automatic Let's Encrypt), and port 4319
is closed to the internet: the rewrite, hooks, and the HTTP MCP all carry tokens, so nothing talks
to the backend in plain HTTP.

```
  Browser ──https──▶ Vercel (dashboard) ──/api/* rewrite──https──▶ Caddy :443 ──▶ localhost:4319 ──▶ SQLite (disk)
```

---

## 1. Backend on Lightsail (profile: `mdd`)

```bash
# one-time: provision a 2 GB Ubuntu box, open 22/80/443, grab the SSH key
./deploy/lightsail/provision.sh
#   → prints the public IP; point a DNS name (e.g. reins.example.com) at it

# one-time, on the box: TLS in front of the backend
sudo apt-get install -y caddy
echo 'reins.example.com { reverse_proxy localhost:4319 }' | sudo tee /etc/caddy/Caddyfile
sudo systemctl enable --now caddy && sudo systemctl reload caddy

# fill in secrets, then ship
cp deploy/lightsail/.env.deploy.example deploy/lightsail/.env.deploy
#   set REINS_SESSION_SECRET (openssl rand -hex 32) and your REINS_LLM_* values
./deploy/lightsail/ship.sh <public-ip>
#   → builds the container, starts it, and prints your workspace tokens (once!)
```

`ship.sh` is also your redeploy command — re-run it after any change. It now takes a
verified DB backup first, then rsyncs, rebuilds, and waits for `/health` before returning
(so a broken deploy fails loudly instead of silently). The `.env` push is optional: with a
local `deploy/lightsail/.env.deploy` it pushes it; without one it keeps the box's existing
`.env` (how CI deploys, so prod secrets never leave the box).

### CI/CD — on-box (free, no GitHub Actions)

If GitHub Actions isn't available (billing, etc.), run CI/CD on the Lightsail box you already
pay for. A systemd timer polls `main`, runs the tests in a throwaway container, and only on
green backs up + rebuilds the live container. For a public repo this is also *safer* than a
self-hosted Actions runner, since it only ever builds `main` — untrusted fork-PR code never runs.

One-time, on the box (as `ubuntu`):

```bash
curl -fsSL https://raw.githubusercontent.com/aruntemme/reins/main/deploy/lightsail/setup-ci.sh | bash
#   or: git clone the repo and run deploy/lightsail/setup-ci.sh
```

Then every push to `main` is tested and deployed within a few minutes. Useful commands:

```bash
journalctl -u reins-ci.service -f          # watch a run
sudo systemctl start reins-ci.service      # force a run now
sudo systemctl disable --now reins-ci.timer # pause it
```

### CI (GitHub Actions)

`.github/workflows/ci.yml` runs on every PR and push to `main`: the server typecheck and test suite,
the CLI tests, and the dashboard build. It does not deploy; deploys stay on-box (above) or manual
(`ship.sh`). The dashboard keeps auto-deploying on Vercel.

What you get: the container runs with `REINS_AUTH=on`, SQLite on the box's disk (survives
restarts/redeploys), and three tokens (admin / ingest / access) from the bootstrap step.

> Cost: Lightsail `small_2_0` is ~$12/mo. Drop to `micro_2_0` (~$5) if the LLM is remote.

---

## 2. Dashboard on Vercel

Point Vercel at the **`web/`** directory:

- **Root Directory:** `web`
- **Env var:** `REINS_URL = https://reins.example.com` (the Caddy domain)
- Framework auto-detected (Next.js). Deploy.

`web/next.config.mjs` rewrites `/api/*` to `REINS_URL`, so the browser stays same-origin.

---

## 3. Onboard the team

Invite teammates from the dashboard; signing up from the invite link joins your workspace. Each
teammate then runs, in their repo (the project's Connect page shows the exact command):

```bash
npx reins-hook --url https://<your-vercel-app> --project <id>
```

It signs them in through the browser, so nobody copies tokens.

---

## Notes
- **Backups:** `ship.sh` and the on-box CI both take a verified online backup before every deploy
  (newest 14 kept, on the box under `/data/backups/`; `ship.sh` also pulls a copy to
  `deploy/lightsail/backups/`). For an extra copy, snapshot the Lightsail instance.
- **Client IPs:** with Vercel → Caddy in front, set `REINS_TRUST_PROXY=2` in the box's `.env` so
  login/signup limits see real client IPs (see `SELFHOST.md`, section 8).
- **Scale later:** SQLite-on-disk is fine for a team. For HA/multi-instance, swap `server/src/db.ts`
  to Postgres (small schema) and move to ECS/Fargate — see git history for the Docker/ECR setup
  (`server/Dockerfile`, `deploy/aws/push-ecr.sh`) which still apply.
