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
echo "  • Re-deploy after changes: ./deploy/lightsail/ship.sh ${IP}"
