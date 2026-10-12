#!/bin/bash
# carousel/autopilot/install.sh — set up (or refresh) the daily Instagram autopilot on this Mac.
#
#   bash ~/pdd-aggregator/carousel/autopilot/install.sh            install and arm
#   bash ~/pdd-aggregator/carousel/autopilot/install.sh --paused   install with the off switch on
#
# Creates the dedicated checkout ~/pdd-autopost (a detached worktree of ~/pdd-aggregator that run.sh
# resets to origin/main each day, so the autopilot only ever runs merged code), links .env into it,
# and loads the launchd job. Safe to re-run.
set -euo pipefail
SRC="$HOME/pdd-aggregator"
DEST="$HOME/pdd-autopost"
PLIST="$HOME/Library/LaunchAgents/uk.prizedrawsdaily.autopost.plist"

git -C "$SRC" fetch -q origin
if [[ ! -d "$DEST" ]]; then
  git -C "$SRC" worktree add -q --detach "$DEST" origin/main
else
  git -C "$DEST" reset -q --hard origin/main
fi
ln -sfn "$SRC/.env" "$DEST/.env"
[[ -f "$DEST/carousel/autopilot/run.sh" ]] || { echo "✗ origin/main has no carousel/autopilot/run.sh — merge the autopilot PR first"; exit 1; }
(cd "$DEST" && bun install --frozen-lockfile >/dev/null)

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/pdd-autopost" "$HOME/pdd-autopost-work"
sed "s#__HOME__#$HOME#g" "$DEST/carousel/autopilot/uk.prizedrawsdaily.autopost.plist" > "$PLIST"
launchctl bootout "gui/$(id -u)/uk.prizedrawsdaily.autopost" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

if [[ "${1:-}" == "--paused" ]]; then touch "$HOME/.pdd-autopost-off"; fi
echo "✓ installed: daily at 16:15 Mac time → $DEST/carousel/autopilot/run.sh"
echo "  logs:      ~/Library/Logs/pdd-autopost/"
if [[ -e "$HOME/.pdd-autopost-off" ]]; then echo "  state:     PAUSED (rm ~/.pdd-autopost-off to arm)"; else echo "  state:     ARMED"; fi
echo "  run now:   launchctl kickstart gui/$(id -u)/uk.prizedrawsdaily.autopost"
echo "  dry run:   bash $DEST/carousel/autopilot/run.sh --dry-run"
