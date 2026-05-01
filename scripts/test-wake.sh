#!/bin/bash
# test-wake.sh — end-to-end live test of dispatch schedule's
# wake-from-sleep + idempotent gate behavior. Putting the Mac to sleep
# terminates this shell, so the test is split into two phases: setup
# captures a baseline, then you sleep and wake the Mac, then verify
# parses the log and prints PASS/FAIL.
#
# Usage:
#   ./scripts/test-wake.sh setup    — register probe schedule, capture 90s baseline
#   ./scripts/test-wake.sh verify   — after wake, analyze log
#   ./scripts/test-wake.sh cleanup  — remove probe + reset env, no-op verify

PROBE_NAME="wake-probe"
PROBE_LOG="/tmp/dispatch-wake-probe.log"
STATE_FILE="/tmp/dispatch-wake-probe.state"
WAKE_WINDOW=300   # 5 min — generous so wake is detected even if test runs slow
WAKE_DELAY=15     # 15s — short enough to verify quickly, long enough to be obvious

cmd="${1:-help}"

current_wake_sec() {
  sysctl -n kern.waketime 2>/dev/null | awk -F '[= ,]+' '{
    for (i = 1; i < NF; i++) if ($i == "sec") { print $(i+1); exit }
  }'
}

cleanup_state() {
  dispatch schedule remove "$PROBE_NAME" 2>/dev/null || true
  launchctl unsetenv DISPATCH_SCHEDULE_WAKE_WINDOW 2>/dev/null || true
  launchctl unsetenv DISPATCH_SCHEDULE_WAKE_DELAY 2>/dev/null || true
  rm -f "$STATE_FILE" "$PROBE_LOG"
}

case "$cmd" in
  setup)
    if ! command -v dispatch >/dev/null 2>&1; then
      echo "ERROR: dispatch not on PATH" >&2
      exit 1
    fi

    cleanup_state

    # Make the wake-delay knobs visible to launchd-spawned agents.
    launchctl setenv DISPATCH_SCHEDULE_WAKE_WINDOW "$WAKE_WINDOW"
    launchctl setenv DISPATCH_SCHEDULE_WAKE_DELAY "$WAKE_DELAY"

    # Probe command logs `fire <epoch>` each minute. Kept deliberately minimal
    # — embedding awk's $(i+1) in shell command substitution caused parse errors
    # in the outer shell. The verify phase computes wake_age externally.
    PROBE_CMD='echo "fire $(date +%s)" >> '"$PROBE_LOG"

    dispatch schedule add "$PROBE_NAME" --cron "* * * * *" --command "$PROBE_CMD"

    echo
    echo "==========================================================="
    echo " Probe registered. Settings:"
    echo "   WAKE_WINDOW = ${WAKE_WINDOW}s"
    echo "   WAKE_DELAY  = ${WAKE_DELAY}s"
    echo "==========================================================="
    echo
    BASELINE_SECS="${TEST_WAKE_BASELINE_SECS:-90}"
    echo "Capturing ${BASELINE_SECS}s baseline (you should see ~1 fire) ..."
    sleep "$BASELINE_SECS"

    SETUP_DONE_TS=$(date +%s)
    echo "$SETUP_DONE_TS" > "$STATE_FILE"

    echo
    echo "Baseline log so far:"
    if [ -s "$PROBE_LOG" ]; then
      sed 's/^/  /' "$PROBE_LOG"
    else
      echo "  (empty — schedule may not have fired yet; ok if just past the minute boundary)"
    fi

    echo
    echo "==========================================================="
    echo " Setup complete @ $(date)."
    echo
    echo " Now:"
    echo "  1. Run \`pmset sleepnow\` (or close the lid) for AT LEAST 3 MINUTES."
    echo "  2. Wake the Mac (open lid / press a key)."
    echo "  3. Run: $(cd "$(dirname "$0")" && pwd)/test-wake.sh verify"
    echo "==========================================================="
    ;;

  verify)
    if [ ! -f "$STATE_FILE" ]; then
      echo "ERROR: no setup state — run './test-wake.sh setup' first" >&2
      exit 1
    fi

    SETUP_DONE_TS=$(cat "$STATE_FILE")
    NOW_SEC=$(date +%s)
    WAKE_SEC=$(current_wake_sec)
    if [ -z "$WAKE_SEC" ]; then
      echo "ERROR: could not parse kern.waketime" >&2
      exit 1
    fi
    AGE=$((NOW_SEC - WAKE_SEC))

    echo
    echo "Verification @ $(date)"
    echo "  setup completed @ $SETUP_DONE_TS  ($(date -r "$SETUP_DONE_TS"))"
    echo "  last wake       @ $WAKE_SEC  ($(date -r "$WAKE_SEC"))"
    echo "  now             @ $NOW_SEC  (wake was ${AGE}s ago)"

    if [ "$WAKE_SEC" -le "$SETUP_DONE_TS" ]; then
      echo
      echo "FAIL: kern.waketime hasn't advanced past setup time."
      echo "      That means the Mac never actually slept (or already woke before setup finished)."
      cleanup_state
      exit 1
    fi

    SLEEP_DURATION=$((WAKE_SEC - SETUP_DONE_TS))
    echo "  detected sleep cycle: ~${SLEEP_DURATION}s"

    if [ ! -f "$PROBE_LOG" ]; then
      echo "FAIL: probe log missing — schedule never fired at all."
      cleanup_state
      exit 1
    fi

    EXTRACT_TS='grep -oE "fire [0-9]+" "$PROBE_LOG" | awk '\''{print $2}'\'''
    BASELINE_FIRES=$(eval "$EXTRACT_TS" | awk -v s="$SETUP_DONE_TS" '$1<=s{c++} END{print c+0}')
    DURING_SLEEP_FIRES=$(eval "$EXTRACT_TS" | awk -v s="$SETUP_DONE_TS" -v w="$WAKE_SEC" '$1>s && $1<w {c++} END{print c+0}')
    POST_WAKE_FIRES=$(eval "$EXTRACT_TS" | awk -v w="$WAKE_SEC" '$1>=w{c++} END{print c+0}')
    FIRST_POST_WAKE=$(eval "$EXTRACT_TS" | awk -v w="$WAKE_SEC" '$1>=w{print; exit}')

    echo
    echo "  baseline fires (≤ setup_done):     $BASELINE_FIRES"
    echo "  fires during sleep (s..w):         $DURING_SLEEP_FIRES  (should be 0)"
    echo "  post-wake fires (≥ wake):          $POST_WAKE_FIRES"

    VERDICT=PASS
    REASONS=()

    if [ "$DURING_SLEEP_FIRES" -gt 0 ]; then
      VERDICT=FAIL
      REASONS+=("Schedule fired DURING sleep — that shouldn't happen")
    fi

    if [ "$POST_WAKE_FIRES" -lt 1 ]; then
      VERDICT=FAIL
      REASONS+=("No post-wake fires — wake-coalesce / RunAtLoad path didn't trigger")
    elif [ -n "$FIRST_POST_WAKE" ]; then
      DELAY_OBS=$((FIRST_POST_WAKE - WAKE_SEC))
      MIN_EXP=$((WAKE_DELAY - 10))
      MAX_EXP=$((WAKE_DELAY + 90))   # +90 covers cron-slot alignment slack
      echo "  first post-wake fire @ $FIRST_POST_WAKE — ${DELAY_OBS}s after wake"
      echo "  expected delay window:     [${MIN_EXP}s, ${MAX_EXP}s]"
      if [ "$DELAY_OBS" -lt "$MIN_EXP" ] || [ "$DELAY_OBS" -gt "$MAX_EXP" ]; then
        VERDICT=FAIL
        REASONS+=("Post-wake fire delay (${DELAY_OBS}s) outside expected [${MIN_EXP}, ${MAX_EXP}]")
      fi
    fi

    echo
    echo "==========================================================="
    echo "VERDICT: $VERDICT"
    if [ "$VERDICT" = "FAIL" ]; then
      for r in "${REASONS[@]}"; do echo "  - $r"; done
    else
      echo "  - schedule fired pre-sleep"
      echo "  - no fires during sleep"
      echo "  - at least one fire after wake"
      echo "  - first post-wake fire respected the wake-delay window"
    fi
    echo "==========================================================="
    echo
    echo "Full probe log:"
    if [ -s "$PROBE_LOG" ]; then
      sed 's/^/  /' "$PROBE_LOG"
    else
      echo "  (empty)"
    fi

    cleanup_state

    [ "$VERDICT" = "PASS" ]
    ;;

  cleanup)
    cleanup_state
    echo "Cleaned up wake-probe state."
    ;;

  help|*)
    cat <<EOF
test-wake.sh — end-to-end live test of wake/sleep + idempotent gate

Usage:
  ./scripts/test-wake.sh setup    Register a 1-min probe schedule, capture 90s baseline,
                                  set short WAKE_DELAY (${WAKE_DELAY}s) for the test
  ./scripts/test-wake.sh verify   After Mac has slept and woken, analyze log
  ./scripts/test-wake.sh cleanup  Remove probe + reset launchctl env

Recommended flow:
  1. ./scripts/test-wake.sh setup
  2. \`pmset sleepnow\`   (or close the lid)
  3. Wait at least 3 minutes
  4. Wake the Mac
  5. ./scripts/test-wake.sh verify
EOF
    [ "$cmd" = "help" ] && exit 0 || exit 1
    ;;
esac
