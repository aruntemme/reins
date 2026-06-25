#!/usr/bin/env bash
# Ship the Reins backend to the Lightsail box and start it.
#
#   1) cp deploy/lightsail/.env.deploy.example deploy/lightsail/.env.deploy  (fill it in)
#   2) ./deploy/lightsail/ship.sh <public-ip>            # redeploy: code only, no new workspace
#      ./deploy/lightsail/ship.sh <public-ip> --bootstrap # first deploy: also mint "My Team"
#
# The workspace bootstrap is opt-in (--bootstrap). A plain redeploy must NOT
# create another workspace — doing so mints duplicate "My Team" rows + tokens
# on every ship, which is exactly what you don't want once you're live.
set -euo pipefail

IP="${1:?usage: ship.sh <public-ip> [--bootstrap]}"
BOOTSTRAP="${2:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
KEY="${HERE}/reins-key.pem"
ENVFILE="${HERE}/.env.deploy"
SSH="ssh -i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ubuntu@${IP}"

[ -f "$KEY" ] || { echo "missing $KEY — run provision.sh first"; exit 1; }
[ -f "$ENVFILE" ] || { echo "missing $ENVFILE — copy .env.deploy.example and fill it"; exit 1; }

# ── Pre-deploy safety net: snapshot the live DB before we touch anything ──────
# A consistent online backup (better-sqlite3 .backup, run inside the live
# container), pulled OFF the box and integrity-verified. `set -e` means any
# failure here ABORTS the deploy — we never rebuild on top of an unbacked-up DB.
# Skipped only on a brand-new box where no container is running yet.
KEEP=14
BACKUPS_LOCAL="${HERE}/backups"
if $SSH "cd /home/ubuntu/reins && docker compose ps --status running --quiet reins" 2>/dev/null | grep -q .; then
  TS="$(date -u +%Y%m%dT%H%M%SZ)"
  DEST="/data/backups/reins-${TS}.db"
  LOCAL="${BACKUPS_LOCAL}/reins-${TS}.db"
  echo "→ backing up live DB before deploy → ${DEST}"
  # Online backup inside the running container (program fed over stdin — no quoting hell).
  $SSH "cd /home/ubuntu/reins && docker compose exec -T -e BACKUP_DEST=${DEST} reins node" < "${HERE}/backup-db.js"
  # Pull a copy off the box so a lost volume can't take the backups with it.
  mkdir -p "${BACKUPS_LOCAL}"
  $SSH "cd /home/ubuntu/reins && docker compose exec -T reins cat ${DEST}" > "${LOCAL}"
  [ -s "${LOCAL}" ] || { echo "✗ off-box backup copy is empty — aborting deploy"; exit 1; }
  # Verify the off-box copy is a sound SQLite db (catches a truncated transfer).
  if command -v node >/dev/null 2>&1 && [ -d "${ROOT}/server/node_modules/better-sqlite3" ]; then
    node -e "const D=require('${ROOT}/server/node_modules/better-sqlite3');const d=new D(process.argv[1],{readonly:true});if(d.pragma('integrity_check',{simple:true})!=='ok'){console.error('integrity_check failed');process.exit(1)}" "${LOCAL}" \
      || { echo "✗ off-box backup failed integrity check — aborting deploy"; exit 1; }
  fi
  echo "  ✓ backup verified: on box ${DEST}, off box ${LOCAL} ($(wc -c < "${LOCAL}" | tr -d ' ') bytes)"
  # Rotate: keep the newest $KEEP both on the box and locally.
  $SSH "cd /home/ubuntu/reins && docker compose exec -T reins sh -c 'ls -1t /data/backups/reins-*.db 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f'"
  ls -1t "${BACKUPS_LOCAL}"/reins-*.db 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -I{} rm -f {} || true
else
  echo "→ no running container yet — skipping pre-deploy backup (fresh box)"
fi

echo "→ copying server + compose to ${IP}"
rsync -az -e "ssh -i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null" \
  --exclude node_modules --exclude '*.db*' --exclude '.env' \
  "$ROOT/server" "$ROOT/docker-compose.yml" "ubuntu@${IP}:/home/ubuntu/reins/"
scp -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  "$ENVFILE" "ubuntu@${IP}:/home/ubuntu/reins/.env"

echo "→ building + starting container"
$SSH 'cd /home/ubuntu/reins && docker compose up -d --build'

if [ "$BOOTSTRAP" = "--bootstrap" ]; then
  echo "→ bootstrapping a workspace (tokens shown once)"
  $SSH 'cd /home/ubuntu/reins && docker compose exec -T reins npx tsx src/admin.ts create-workspace "My Team"'
else
  echo "→ skipping workspace bootstrap (pass --bootstrap on first deploy only)"
fi

echo
echo "✓ deployed. Backend: http://${IP}:4319"
echo "  • Set REINS_URL=http://${IP}:4319 in your Vercel project, redeploy the dashboard."
echo "  • Onboard teammates: npx reins-hook install --url http://${IP}:4319 --me <name> --token <ingest-token>"
echo "  • Re-deploy after changes: ./deploy/lightsail/ship.sh ${IP}
  • Pre-deploy DB backups: on box /data/backups/ and off box deploy/lightsail/backups/ (newest ${KEEP} kept)
  • Restore a backup: scp it to the box, then
      docker compose cp <backup.db> reins:/data/reins.db && docker compose restart reins
    (stop writers first; this overwrites the live DB)"
