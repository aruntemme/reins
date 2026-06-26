#!/usr/bin/env bash
# On-box CI/CD — a free alternative to GitHub Actions that runs on the Lightsail
# box you already pay for. A systemd timer (reins-ci.timer) runs this every few
# minutes; it polls main, runs the test suite in a THROWAWAY container (no access
# to the live DB), and only on green does it back up + rebuild the live container.
#
# Safe for a PUBLIC repo: it only ever builds main (owner-controlled), so untrusted
# fork-PR code never executes here — unlike a self-hosted Actions runner.
#
# One-time setup on the box: see deploy/lightsail/setup-ci.sh.
set -euo pipefail

SRC="${REINS_CI_SRC:-/home/ubuntu/reins-src}"   # git checkout used for CI
APP="${REINS_CI_APP:-/home/ubuntu/reins}"        # the running app dir (has .env, /data)
BRANCH="${REINS_CI_BRANCH:-main}"
STATE="${SRC}/.last-deployed-sha"
KEEP=14

# Single-flight: a slow build must not overlap the next tick.
exec 9>"/tmp/reins-ci.lock"
flock -n 9 || { echo "another CI run is in progress — skipping"; exit 0; }

cd "$SRC"
git fetch --quiet origin "$BRANCH"
NEW="$(git rev-parse "origin/${BRANCH}")"
OLD="$(cat "$STATE" 2>/dev/null || true)"
[ "$NEW" = "$OLD" ] && exit 0   # nothing new

echo "=== $(date -u +%FT%TZ) new ${BRANCH} @ ${NEW:0:8} — CI starting ==="
git reset --hard --quiet "origin/${BRANCH}"

# ── CI: tests in a throwaway node container (cannot touch the live DB) ──────────
if ! docker run --rm -v "$SRC":/src -w /src node:22 bash -lc '
      set -e
      cd server && npm ci --no-audit --no-fund && npx tsc --noEmit && npm test
      cd ../cli && node --test --test-force-exit "test/**/*.test.mjs"
    '; then
  echo "✗ CI failed @ ${NEW:0:8} — NOT deploying"
  exit 1
fi
echo "✓ CI green"

# ── CD: back up the live DB, sync code into the app dir, rebuild, health check ──
cd "$APP"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
if docker compose ps --status running --quiet reins 2>/dev/null | grep -q .; then
  echo "→ backing up live DB → /data/backups/reins-${TS}.db"
  docker compose exec -T -e BACKUP_DEST="/data/backups/reins-${TS}.db" reins node < "${SRC}/deploy/lightsail/backup-db.js"
  docker compose exec -T reins sh -c "ls -1t /data/backups/reins-*.db 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f"
fi

echo "→ syncing code + rebuilding"
rsync -a --delete --exclude node_modules --exclude '*.db*' --exclude '.env' \
  "${SRC}/server" "${SRC}/docker-compose.yml" "${APP}/"
docker compose up -d --build

echo "→ waiting for health"
for _ in $(seq 1 30); do
  if curl -fsS http://localhost:4319/health >/dev/null 2>&1; then
    echo "$NEW" > "$STATE"
    echo "✓ deployed @ ${NEW:0:8}"
    exit 0
  fi
  sleep 2
done
echo "✗ backend unhealthy after deploy — recent logs:"
docker compose logs --tail 50 reins || true
exit 1
