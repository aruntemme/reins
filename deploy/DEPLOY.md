# Deploying Reins

**Backend + DB → AWS Lightsail** (one small VM, Docker, persistent disk) ·
**Dashboard → Vercel** (Next.js).

The dashboard proxies `/api/*` to the backend *server-side*, so the browser only ever talks to
Vercel over HTTPS — the Lightsail backend can stay plain HTTP (no certs to manage) and sessions
stay first-party.

```
  Browser ──https──▶ Vercel (dashboard) ──/api/* rewrite──▶ http://<lightsail-ip>:4319 ──▶ SQLite (disk)
```

---

## 1. Backend on Lightsail (profile: `mdd`)

```bash
# one-time: provision a 2 GB Ubuntu box, open ports, grab the SSH key
./deploy/lightsail/provision.sh
#   → prints the public IP

# fill in secrets, then ship
cp deploy/lightsail/.env.deploy.example deploy/lightsail/.env.deploy
#   set REINS_SESSION_SECRET (openssl rand -hex 32) and your REINS_LLM_* values
./deploy/lightsail/ship.sh <public-ip>
#   → builds the container, starts it, and prints your workspace tokens (once!)
```

`ship.sh` is also your redeploy command — re-run it after any change.

What you get: the container runs with `REINS_AUTH=on`, SQLite on the box's disk (survives
restarts/redeploys), and three tokens (admin / ingest / access) from the bootstrap step.

> Cost: Lightsail `small_2_0` is ~$12/mo. Drop to `micro_2_0` (~$5) if the LLM is remote.

---

## 2. Dashboard on Vercel

Point Vercel at the **`web/`** directory:

- **Root Directory:** `web`
- **Env var:** `REINS_URL = http://<lightsail-ip>:4319`
- Framework auto-detected (Next.js). Deploy.

`web/next.config.mjs` rewrites `/api/*` to `REINS_URL`, so the browser stays same-origin.

---

## 3. Onboard the team

```bash
npx reins-hook install --url http://<lightsail-ip>:4319 --me asha --token <ingest-token>
# teammates open the Vercel dashboard and paste the access token at /signin
```

---

## Notes
- **Backups:** `ssh` in and `docker compose exec reins cp /data/reins.db /data/backup.db`, or
  snapshot the Lightsail instance.
- **TLS (optional):** put the Lightsail box behind a Lightsail load balancer, or front it with
  Caddy/Cloudflare if you later use `NEXT_PUBLIC_REINS_URL` direct mode.
- **Scale later:** SQLite-on-disk is fine for a team. For HA/multi-instance, swap `server/src/db.ts`
  to Postgres (small schema) and move to ECS/Fargate — see git history for the Docker/ECR setup
  (`server/Dockerfile`, `deploy/aws/push-ecr.sh`) which still apply.
