#!/usr/bin/env bash
# Provision a Lightsail VM for the Reins backend (Docker + persistent disk).
# One-time. Uses the `mdd` AWS profile. Then run ./ship.sh to deploy.
#
#   ./deploy/lightsail/provision.sh
set -euo pipefail

PROFILE="${AWS_PROFILE:-mdd}"
REGION="${AWS_REGION:-us-east-1}"
NAME="${INSTANCE_NAME:-reins}"
BUNDLE="${BUNDLE:-small_2_0}"        # 2 GB RAM — enough to build better-sqlite3
BLUEPRINT="${BLUEPRINT:-ubuntu_22_04}"
AZ="${AZ:-${REGION}a}"
HERE="$(cd "$(dirname "$0")" && pwd)"
KEY="${HERE}/reins-key.pem"

aws() { command aws --profile "$PROFILE" --region "$REGION" "$@"; }

echo "→ creating Lightsail instance '${NAME}' (${BUNDLE}, ${BLUEPRINT}) in ${AZ}"
aws lightsail create-instances \
  --instance-names "$NAME" \
  --availability-zone "$AZ" \
  --blueprint-id "$BLUEPRINT" \
  --bundle-id "$BUNDLE" \
  --user-data "$(cat "${HERE}/cloud-init.sh")" >/dev/null

echo "→ waiting for it to run…"
until [ "$(aws lightsail get-instance-state --instance-name "$NAME" --query 'state.name' --output text 2>/dev/null)" = "running" ]; do
  sleep 5; printf "."
done
echo

echo "→ opening firewall (22 ssh, 4319 reins)"
aws lightsail put-instance-public-ports --instance-name "$NAME" --port-infos \
  "fromPort=22,toPort=22,protocol=TCP" "fromPort=4319,toPort=4319,protocol=TCP" >/dev/null

echo "→ downloading SSH key → ${KEY}"
aws lightsail download-default-key-pair --query 'privateKeyBase64' --output text > "$KEY"
chmod 600 "$KEY"

IP="$(aws lightsail get-instance --instance-name "$NAME" --query 'instance.publicIpAddress' --output text)"
echo
echo "✓ instance running at ${IP}"
echo "  next:  ./deploy/lightsail/ship.sh ${IP}"
echo "  (give cloud-init ~60s to finish installing Docker first)"
