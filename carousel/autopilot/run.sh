#!/bin/bash
# carousel/autopilot/run.sh — the Instagram autopilot. launchd starts it at 16:45 and 17:45 IST
# (uk.prizedrawsdaily.autopost; one of the two lands at 12:15 UK); the task itself is
# carousel/AUTOPILOT.md, run by headless Claude. The Reel slots (uk.prizedrawsdaily.autopost-slots)
# start it with --slot.
#
#   run.sh                   live: may publish to Instagram
#   run.sh --dry-run         everything up to the caption; the publishing tools are NOT granted to Claude
#   run.sh --slot            post the queued Reel that is due at this UK hour (queue.mjs), if any
#   run.sh --slot --dry-run  say what is due, post nothing
#
# Off switch: touch ~/.pdd-autopost-off   (on again: rm ~/.pdd-autopost-off)
#
# The whole script is one function so bash has parsed all of it before the git reset below can
# replace the file on disk, and the reset is followed by an exec of the fresh copy.
set -uo pipefail

GH_REPO="chanakya-goyal/prizedrawsdaily-aggregator"

main() {
  local REPO="${AUTOPOST_REPO:-$HOME/pdd-autopost}"
  export PDD_DIR="${PDD_DIR:-$HOME/pdd-autopost-work}"
  local LOGDIR="$HOME/Library/Logs/pdd-autopost"
  local DRY=0
  [[ " $* " == *" --dry-run "* || "${AUTOPOST_DRY_RUN:-0}" == "1" ]] && DRY=1
  export AUTOPOST_DRY_RUN=$DRY
  mkdir -p "$LOGDIR" "$PDD_DIR"
  local DAY; DAY=$(TZ=Europe/London date +%Y-%m-%d)
  exec >>"$LOGDIR/$DAY.log" 2>&1
  echo "=== $(date -u +%FT%TZ) autopost start (dry=$DRY, repo=$REPO)"

  if [[ -e "$HOME/.pdd-autopost-off" && $DRY == 0 ]]; then echo "off switch ~/.pdd-autopost-off present: not running"; return 0; fi

  # Not inside $PDD_DIR: plan.mjs archives everything in the work dir, the lock included.
  local LOCK="$LOGDIR/.autopost.lock"
  if ! mkdir "$LOCK" 2>/dev/null; then echo "another run holds $LOCK: not running"; return 0; fi
  trap "rm -rf '$LOCK'" EXIT    # expanded now: LOCK is local and gone by the time EXIT fires

  cd "$REPO" || { alarm "the autopost checkout $REPO is missing"; return 1; }

  # Run only merged code: sync this dedicated checkout to origin/main, then re-exec the fresh script.
  if [[ "${AUTOPOST_SYNCED:-0}" != 1 && "${AUTOPOST_NO_SYNC:-0}" != 1 ]]; then
    if ! { git fetch -q origin && git reset -q --hard origin/main; }; then alarm "git sync of $REPO failed"; return 1; fi
    rm -rf "$LOCK"; trap - EXIT
    AUTOPOST_SYNCED=1 exec bash "$REPO/carousel/autopilot/run.sh" "$@"
  fi
  echo "code: $(git log --oneline -1)"

  bun install --frozen-lockfile >/dev/null || { alarm "bun install failed"; return 1; }

  # The Reel slots (17:45 UK, 07:45 UK next morning): post one queued Reel, nothing else.
  if [[ " $* " == *" --slot "* ]]; then run_slot "$DAY" "$DRY"; return $?; fi

  if [[ $DRY == 0 ]]; then
    bun carousel/autopilot/status.mjs window || { echo "outside the UK posting window: waiting for tomorrow"; return 0; }
    if bun carousel/autopilot/status.mjs published-today; then echo "today's carousel is already published"; return 0; fi
  fi

  local GATES
  if ! GATES=$(bun run test:gates 2>&1); then
    echo "$GATES" | tail -25
    alarm "the carousel gates are red on origin/main"; return 1
  fi
  echo "gates: $(echo "$GATES" | grep -E '^\s*[0-9]+ pass' | tr -s ' ')"

  # Tools Claude may use. dontAsk refuses everything else without prompting. In a dry run the
  # Composio execute tool and the publishing scripts are simply not available.
  local ALLOW="Read,Write,Edit,Glob,Grep,Bash(bun carousel/*),Bash(ONLY_CATEGORY=* bun carousel/plan.mjs),Bash(ls *),Bash(cat *),Bash(head *),Bash(tail *),Bash(wc *),Bash(sips *),mcp__composio__COMPOSIO_SEARCH_TOOLS,mcp__composio__COMPOSIO_GET_TOOL_SCHEMAS"
  local DENY="Bash(bun carousel/publish.mjs*),Bash(bun carousel/state-mark.mjs*),Bash(bun carousel/cleanup.mjs*),Bash(bun carousel/autopilot/queue.mjs*),mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL"
  local MODE="MODE: DRY RUN (AUTOPOST_DRY_RUN=1). Stop where AUTOPILOT.md says DRY RUN STOPS HERE."
  if [[ $DRY == 0 ]]; then
    ALLOW="$ALLOW,mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL"
    # the lunchtime run QUEUES Reels; only the slot run may mark one done or drop one
    DENY="Bash(bun carousel/autopilot/queue.mjs done*),Bash(bun carousel/autopilot/queue.mjs drop*),mcp__composio__COMPOSIO_REMOTE_BASH_TOOL,mcp__composio__COMPOSIO_REMOTE_WORKBENCH,mcp__composio__COMPOSIO_MANAGE_CONNECTIONS"
    MODE="MODE: LIVE. Publish to Instagram when every check passes."
  fi

  mkdir -p "$PDD_DIR/out"; rm -f "$PDD_DIR/out/REPORT.md"
  echo "claude: start"
  # 90-minute ceiling (macOS has no `timeout`): perl's alarm kills a hung run.
  { echo "HOST: the owner's Mac (Composio MCP)."; echo "$MODE"; echo "PDD_DIR=$PDD_DIR  (the work directory; already set in your environment)"; echo; cat carousel/autopilot/BOOTSTRAP.txt; } | perl -e 'alarm shift; exec @ARGV' 5400 \
    claude -p --model opus --permission-mode dontAsk --add-dir "$PDD_DIR" \
      --allowedTools "$ALLOW" --disallowedTools "$DENY" --output-format json \
      > "$LOGDIR/$DAY-claude.json"
  local RC=$?
  echo "claude: exit $RC"

  local STATUS NOTE=""
  STATUS=$(bun carousel/autopilot/status.mjs report "$PDD_DIR/out/REPORT.md")
  if [[ -z "$STATUS" ]]; then STATUS=FAILED; NOTE="no readable REPORT.md (claude exit $RC; 142 = the 90-minute ceiling)"; fi
  # The report is Claude's account; the state table is the evidence. They must agree.
  if [[ $STATUS == PUBLISHED ]] && ! bun carousel/autopilot/status.mjs published-today; then
    STATUS=FAILED; NOTE="REPORT.md says PUBLISHED but today's carousel row is not published"
  fi
  if [[ $DRY == 1 && $STATUS == PUBLISHED ]]; then STATUS=FAILED; NOTE="a dry run reported PUBLISHED"; fi
  echo "status: $STATUS ${NOTE}"

  report "$DAY" "$STATUS" "$NOTE" "$DRY"
  if [[ $DRY == 0 && ( $STATUS == SKIPPED || $STATUS == FAILED ) ]]; then
    alarm "$STATUS: $(sed -n '2,4p' "$PDD_DIR/out/REPORT.md" 2>/dev/null | tr '\n' ' ' | cut -c1-200) ${NOTE}"
  fi
  notify "Instagram autopilot: $STATUS"
  echo "=== $(date -u +%FT%TZ) autopost end"
}

# One queued Reel (carousel/autopilot/queue.mjs). queue.mjs decides what is due at this UK hour and
# whether its draw is still open; a short Claude run with ONLY the publish tools posts it.
run_slot() {
  local DAY=$1 DRY=$2 Q="${AUTOPOST_QUEUE:-$HOME/pdd-autopost-queue}" DUE SLOT DATE
  mkdir -p "$Q"
  if ! DUE=$(bun carousel/autopilot/queue.mjs due auto); then echo "slot: $DUE"; return 0; fi
  SLOT=$(echo "$DUE" | head -1 | cut -d' ' -f2); DATE=$(echo "$DUE" | head -1 | cut -d' ' -f3)
  echo "slot: $SLOT (built $DATE) is due"
  if [[ $DRY == 1 ]]; then echo "$DUE"; echo "dry run: not posting"; return 0; fi
  # With a Composio API key (in .env) the Mac posts exactly as the cloud backup does: one script, Instagram
  # then Facebook, no Claude session. `due` above already claimed the row, so hand it back first.
  if bun -e 'process.exit(process.env.COMPOSIO_API_KEY ? 0 : 1)'; then
    bun carousel/autopilot/queue.mjs release "$SLOT" >/dev/null
    local OUT RC; OUT=$(bun carousel/ig-publish.mjs reel "$SLOT" 2>&1); RC=$?
    echo "$OUT"
    local SSTATUS=PUBLISHED; [[ $RC -eq 3 ]] && { echo "slot: nothing to post after all"; return 0; }
    [[ $RC -ne 0 ]] && SSTATUS=FAILED
    printf 'STATUS: %s
slot: %s
```
%s
```
' "$SSTATUS" "$SLOT" "$(echo "$OUT" | tail -6)" > "$Q/REPORT-$SLOT.md"
    report "$DAY · $SLOT" "$SSTATUS" "" 0 "$Q/REPORT-$SLOT.md"
    [[ $SSTATUS == FAILED ]] && alarm "Reel slot $SLOT FAILED: $(echo "$OUT" | tail -2 | tr '\n' ' ' | cut -c1-200)"
    notify "Instagram Reel ($SLOT): $SSTATUS"
    return 0
  fi
  local REPORT="$Q/REPORT-$SLOT.md"; rm -f "$REPORT"
  local ALLOW="Read,Write,Bash(bun carousel/autopilot/queue.mjs *),mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL,mcp__composio__COMPOSIO_SEARCH_TOOLS,mcp__composio__COMPOSIO_GET_TOOL_SCHEMAS"
  local DENY="mcp__composio__COMPOSIO_REMOTE_BASH_TOOL,mcp__composio__COMPOSIO_REMOTE_WORKBENCH,mcp__composio__COMPOSIO_MANAGE_CONNECTIONS"
  echo "claude: start ($SLOT)"
  { echo "SLOT=$SLOT  DATE=$DATE  REPORT=$REPORT"; echo; echo "The item that is due:"; echo "$DUE" | tail -n +2; echo; cat carousel/autopilot/PUBLISH_SLOT.md; } \
    | perl -e 'alarm shift; exec @ARGV' 1200 \
    claude -p --model sonnet --permission-mode dontAsk --add-dir "$Q" \
      --allowedTools "$ALLOW" --disallowedTools "$DENY" --output-format json > "$LOGDIR/$DAY-$SLOT-claude.json"
  echo "claude: exit $?"
  local STATUS=PUBLISHED NOTE=""
  # The report is Claude's account; the state row is the evidence.
  if ! bun carousel/autopilot/queue.mjs published "$SLOT" "$DATE"; then
    STATUS=FAILED; NOTE="the $SLOT row for $DATE is not published"
    bun carousel/autopilot/queue.mjs release "$SLOT"   # the cloud backup may still post it inside the window
  fi
  echo "status: $STATUS $NOTE"
  report "$DAY · $SLOT" "$STATUS" "$NOTE" 0 "$REPORT"
  [[ $STATUS == FAILED ]] && alarm "Reel slot $SLOT FAILED: $(sed -n '2,3p' "$REPORT" 2>/dev/null | tr '\n' ' ' | cut -c1-200) $NOTE"
  notify "Instagram Reel ($SLOT): $STATUS"
  return 0
}

# Every run appends its REPORT.md to one pinned "Autopost log" issue: the history, readable on a phone.
report() {
  local day=$1 status=$2 note=$3 dry=$4 file=${5:-$PDD_DIR/out/REPORT.md} n
  gh label create autopost-log --repo "$GH_REPO" --color 0E8A16 --description "Instagram autopilot daily log" --force >/dev/null 2>&1
  n=$(gh issue list --repo "$GH_REPO" --label autopost-log --state open --json number --jq '.[0].number' 2>/dev/null)
  if [[ -z "$n" ]]; then
    n=$(gh issue create --repo "$GH_REPO" --title "Autopost log" --label autopost-log \
      --body "One comment per run of carousel/autopilot/run.sh. Alarms (skipped or failed days) open a separate issue labelled \`autopost\`." 2>/dev/null | grep -oE '[0-9]+$')
  fi
  [[ -z "$n" ]] && { echo "report: could not reach the log issue"; return 0; }
  {
    echo "**$day · $status**$([[ $dry == 1 ]] && echo ' (dry run)')${note:+ · $note}"
    echo
    sed -n '2,40p' "$file" 2>/dev/null
  } | gh issue comment "$n" --repo "$GH_REPO" --body-file - >/dev/null 2>&1 && echo "report: posted to issue #$n"
}

# An alarm is dispatched to the watchdog Action, so the issue it opens is written by the bot.
# GitHub does not notify you about your own comments, so a comment from this Mac would be silent.
alarm() {
  echo "ALARM: $1"
  gh workflow run autopost-watchdog.yml --repo "$GH_REPO" -f reason="$1" >/dev/null 2>&1 || echo "alarm: dispatch failed"
  notify "Instagram autopilot: $1"
}

notify() { osascript -e "display notification \"${1//\"/}\" with title \"PrizeDrawsDaily\"" >/dev/null 2>&1 || true; }

main "$@"
