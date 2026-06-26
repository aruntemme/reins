#!/usr/bin/env bash
# One-time setup for the free on-box CI/CD. Run this ON the Lightsail box (as the
# ubuntu user). It clones the repo for CI, installs the systemd timer, and starts
# it. After this, every push to main is tested + deployed automatically — no
# GitHub Actions, no extra cost beyond the box you already run.
set -euo pipefail

REPO="${REINS_REPO:-https://github.com/aruntemme/reins.git}"
SRC="${REINS_CI_SRC:-/home/ubuntu/reins-src}"
APP="${REINS_CI_APP:-/home/ubuntu/reins}"

[ -d "$APP" ] || { echo "expected the running app at $APP (deploy once with ship.sh first)"; exit 1; }

if [ ! -d "$SRC/.git" ]; then
  echo "→ cloning $REPO → $SRC"
  git clone "$REPO" "$SRC"
else
  echo "→ $SRC already cloned"
fi

# Seed the deployed-sha marker so we don't immediately redeploy the current code.
git -C "$SRC" fetch --quiet origin main
git -C "$SRC" rev-parse origin/main > "$SRC/.last-deployed-sha"

echo "→ installing systemd timer"
sudo cp "$SRC/deploy/lightsail/reins-ci.service" /etc/systemd/system/reins-ci.service
sudo cp "$SRC/deploy/lightsail/reins-ci.timer"   /etc/systemd/system/reins-ci.timer
sudo systemctl daemon-reload
sudo systemctl enable --now reins-ci.timer

echo
echo "✓ on-box CI/CD is live. It checks main every ~3 minutes."
echo "  • watch a run:   journalctl -u reins-ci.service -f"
echo "  • force a run:   sudo systemctl start reins-ci.service"
echo "  • pause it:      sudo systemctl disable --now reins-ci.timer"
echo "  • timer status:  systemctl list-timers reins-ci.timer"
