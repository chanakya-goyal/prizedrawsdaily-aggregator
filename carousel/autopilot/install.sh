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
# Two jobs: the lunchtime build + carousel (autopost) and the Reel slots (autopost-slots).
for LABEL in uk.prizedrawsdaily.autopost uk.prizedrawsdaily.autopost-slots; do
  P="$HOME/Library/LaunchAgents/$LABEL.plist"
  sed "s#__HOME__#$HOME#g" "$DEST/carousel/autopilot/$LABEL.plist" > "$P"
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$P"
done
mkdir -p "$HOME/pdd-autopost-queue"

if [[ "${1:-}" == "--paused" ]]; then touch "$HOME/.pdd-autopost-off"; fi
echo "✓ installed: lunchtime build + carousel at 12:15 UK (16:45/17:45 Mac time) → $DEST/carousel/autopilot/run.sh"
echo "  reels:     17:45 UK and 07:45 UK next morning (run.sh --slot, queue in ~/pdd-autopost-queue)"
echo "  logs:      ~/Library/Logs/pdd-autopost/"
if [[ -e "$HOME/.pdd-autopost-off" ]]; then echo "  state:     PAUSED (rm ~/.pdd-autopost-off to arm)"; else echo "  state:     ARMED"; fi
echo "  run now:   launchctl kickstart gui/$(id -u)/uk.prizedrawsdaily.autopost"
echo "  dry run:   bash $DEST/carousel/autopilot/run.sh --dry-run"
