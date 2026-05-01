#!/bin/bash
# dispatch-cron-wrapper.sh — invoked by launchd when a dispatch schedule fires.
#
# Reads metadata from ~/.dispatch/schedules/<name>.yml, picks up the user's
# PATH from their shell profile, then launches the scheduled work (either a
# `dispatch run --headless` call or a raw command) with stdout/stderr piped to
# a timestamped log under ~/.dispatch/scheduled-logs/.
#
# Usage: dispatch-cron-wrapper.sh <schedule-name>

NAME="${1:-}"
if [ -z "$NAME" ]; then
  echo "ERROR: schedule name required" >&2
  exit 2
fi

SCHEDULE_DIR="$HOME/.dispatch/schedules"
META_FILE="$SCHEDULE_DIR/$NAME.yml"
LOG_DIR="$HOME/.dispatch/scheduled-logs"
mkdir -p "$LOG_DIR"

TS=$(date +%Y%m%d-%H%M%S)
LOG_FILE="$LOG_DIR/$NAME-$TS.log"

# Tee everything to the log, while also letting launchd capture stdout/stderr.
exec > >(tee -a "$LOG_FILE") 2>&1

echo "=== Schedule fired: $NAME @ $(date -Iseconds 2>/dev/null || date) ==="
echo "Log: $LOG_FILE"

if [ ! -f "$META_FILE" ]; then
  echo "ERROR: metadata not found at $META_FILE" >&2
  exit 1
fi

# Pick up the user's PATH from their shell profile. launchd starts processes
# with a minimal env, so things like gcloud/secret-agent/uv/claude/dispatch
# typically aren't reachable. Run the user's actual shell in a subprocess so
# their rc file (zshrc / bash_profile) executes in the right interpreter, then
# export the resulting PATH back into this bash wrapper.
USER_SHELL="${SHELL:-/bin/zsh}"
case "$USER_SHELL" in
  *bash*)
    if command -v bash >/dev/null 2>&1; then
      EXTRA_PATH=$(bash -lc 'echo $PATH' 2>/dev/null || true)
    fi
    ;;
  *zsh*|*)
    if command -v zsh >/dev/null 2>&1; then
      EXTRA_PATH=$(zsh -lc 'echo $PATH' 2>/dev/null || true)
    fi
    ;;
esac

if [ -n "${EXTRA_PATH:-}" ]; then
  export PATH="$EXTRA_PATH"
fi
echo "PATH: $PATH"

# Tiny YAML field extractor — pulls a single top-level "key: value" line and
# strips surrounding quotes. Matches the format written by serializeScheduleMeta.
get_field() {
  local key="$1"
  local raw
  raw=$(grep -E "^${key}:" "$META_FILE" | head -n1 | sed -E "s/^${key}:[[:space:]]*//")
  # Strip surrounding double or single quotes
  raw="${raw#\"}"; raw="${raw%\"}"
  raw="${raw#\'}"; raw="${raw%\'}"
  # Unescape \" → "
  raw="${raw//\\\"/\"}"
  printf '%s' "$raw"
}

PROMPT_FILE=$(get_field prompt_file)
COMMAND_FIELD=$(get_field command)
BRANCH_PREFIX=$(get_field branch_prefix)
MODEL=$(get_field model)
REPO=$(get_field repo)
MAX_TURNS=$(get_field max_turns)
NOTIFY=$(get_field notify)
RUN_ONCE=$(get_field run_once)

# Idempotency gate: ask dispatch whether this slot has already been served
# successfully (so RunAtLoad on routine logins doesn't re-fire after each one).
# Bypassed when DISPATCH_SCHEDULE_FORCE=1 (used by `dispatch schedule run`).
if [ "${DISPATCH_SCHEDULE_FORCE:-}" != "1" ]; then
  if command -v dispatch >/dev/null 2>&1; then
    GATE_OUT=$(dispatch _schedule-should-fire "$NAME" 2>&1)
    GATE_RC=$?
    echo "$GATE_OUT"
    if [ "$GATE_RC" -eq 10 ]; then
      echo "=== Skipped (gate said this slot already fired) ==="
      exit 0
    elif [ "$GATE_RC" -ne 0 ]; then
      echo "WARN: gate returned $GATE_RC — proceeding anyway"
    fi
  else
    echo "WARN: dispatch not on PATH at gate-check; proceeding without idempotency check"
  fi
fi

# Wake/boot settle delay: if we're firing very shortly after a system wake
# (or fresh boot — kern.waketime is updated for both), sleep before doing
# work so the network, VPN, gcloud auth, etc. have time to come back up.
#
# Tunables (env vars):
#   DISPATCH_SCHEDULE_WAKE_WINDOW   — seconds since wake that count as
#                                     "wake-triggered" (default: 60)
#   DISPATCH_SCHEDULE_WAKE_DELAY    — seconds to sleep when wake-triggered
#                                     (default: 300 = 5 minutes)
#   DISPATCH_SCHEDULE_NO_DELAY=1    — skip the delay even if wake-triggered
#
# DISPATCH_SCHEDULE_FORCE=1 (manual `dispatch schedule run`) also skips it —
# you're firing on purpose and don't want to wait 5 minutes.
if [ "${DISPATCH_SCHEDULE_FORCE:-}" != "1" ] && [ "${DISPATCH_SCHEDULE_NO_DELAY:-}" != "1" ]; then
  WAKE_WINDOW="${DISPATCH_SCHEDULE_WAKE_WINDOW:-60}"
  WAKE_DELAY="${DISPATCH_SCHEDULE_WAKE_DELAY:-300}"
  # `sysctl -n kern.waketime` prints "{ sec = N, usec = M } <date>".
  # Greedy regexes match the trailing usec; pull the second field after `{`.
  WAKE_SEC=$(sysctl -n kern.waketime 2>/dev/null | awk -F '[= ,]+' '{
    for (i = 1; i < NF; i++) if ($i == "sec") { print $(i+1); exit }
  }')
  if [[ "$WAKE_SEC" =~ ^[0-9]+$ ]]; then
    NOW_SEC=$(date +%s)
    AGE=$((NOW_SEC - WAKE_SEC))
    if [ "$AGE" -ge 0 ] && [ "$AGE" -lt "$WAKE_WINDOW" ]; then
      echo "=== System woke ${AGE}s ago (< ${WAKE_WINDOW}s window); sleeping ${WAKE_DELAY}s before work ==="
      sleep "$WAKE_DELAY"
      echo "=== Settle delay complete @ $(date) ==="
    else
      echo "Wake age: ${AGE}s (outside settle window — no delay)"
    fi
  fi
fi

if [ -n "$REPO" ]; then
  if ! cd "$REPO"; then
    echo "ERROR: cannot cd into repo: $REPO" >&2
    exit 1
  fi
  echo "Working dir: $REPO"
fi

# For run-once schedules, unload + delete the plist BEFORE invoking the work.
# launchd's StartCalendarInterval has no year field, so a stranded one-off
# plist would fire annually on the same date. Doing cleanup up-front means a
# crashed/killed wrapper still leaves no orphan. The metadata file is kept
# until after the work completes so a retry by hand still has something to
# read; we delete it in the post-work cleanup below.
if [ "$RUN_ONCE" = "true" ]; then
  PLIST="$HOME/Library/LaunchAgents/com.dispatch.$NAME.plist"
  echo "=== Run-once: unloading and removing $PLIST (pre-work) ==="
  launchctl unload -w "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
fi

RC=0
if [ -n "$COMMAND_FIELD" ]; then
  echo "=== Running command: $COMMAND_FIELD ==="
  bash -c "$COMMAND_FIELD" || RC=$?
elif [ -n "$PROMPT_FILE" ]; then
  if [ ! -f "$PROMPT_FILE" ]; then
    echo "ERROR: prompt file not found: $PROMPT_FILE" >&2
    exit 1
  fi
  BRANCH_NAME="${BRANCH_PREFIX:-$NAME}-$(date +%Y%m%d-%H%M)"
  CMD=(dispatch run --headless --no-attach --prompt-file "$PROMPT_FILE" --name "$BRANCH_NAME")
  if [ -n "$MODEL" ]; then CMD+=(--model "$MODEL"); fi
  if [ -n "$MAX_TURNS" ]; then CMD+=(--max-turns "$MAX_TURNS"); fi
  echo "=== Running: ${CMD[*]} ==="
  "${CMD[@]}" || RC=$?
else
  echo "ERROR: schedule has neither command nor prompt_file set" >&2
  exit 1
fi

echo "=== Completed with rc=$RC ==="

# Record this slot as "served" so the gate skips on routine RunAtLoad triggers.
# Only on rc=0 — a failed fire should trigger again on the next RunAtLoad/cron
# fire so the user has a chance to recover.
if [ "$RC" -eq 0 ] && command -v dispatch >/dev/null 2>&1; then
  dispatch _schedule-record-success "$NAME" || echo "WARN: failed to record last_success"
fi

# v1 notification: log a line. Slack send is not yet wired up — there's no
# clean send-only helper in cursor-crm/scripts (only slack_dump.py for reads).
# TODO: replace with a real Slack DM helper once one exists.
if [ "$NOTIFY" = "slack" ]; then
  echo "NOTIFY: schedule '$NAME' fired (rc=$RC). [TODO: post to Slack]"
fi

# Final cleanup of run-once metadata. The plist was already removed pre-work;
# the metadata stays until here so any in-flight tooling can still read it.
if [ "$RUN_ONCE" = "true" ]; then
  echo "=== Run-once: removing metadata $META_FILE ==="
  rm -f "$META_FILE"
fi

exit "$RC"
