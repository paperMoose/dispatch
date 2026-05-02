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
# DISPATCH_BIN is set in the plist's EnvironmentVariables at registration
# time (absolute path of the user's `dispatch` CLI). Use it when present so
# we don't depend on PATH discovering nvm/asdf/etc. installations from
# launchd's clean env. Fall back to PATH lookup otherwise.
if [ -n "${DISPATCH_BIN:-}" ] && [ -x "$DISPATCH_BIN" ]; then
  # Make a `dispatch` shim function so the rest of the script reads the
  # same way as the foreground (`schedule run`) path.
  dispatch() { "$DISPATCH_BIN" "$@"; }
  export -f dispatch
  echo "DISPATCH_BIN: $DISPATCH_BIN"
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
PROMPT_B64=$(get_field prompt_b64)
COMMAND_FIELD=$(get_field command)
BRANCH_PREFIX=$(get_field branch_prefix)
MODEL=$(get_field model)
REPO=$(get_field repo)
MAX_TURNS=$(get_field max_turns)
NOTIFY=$(get_field notify)
RUN_ONCE=$(get_field run_once)

# Inline prompts (prompt_b64) decode to a temp file. This makes schedules
# self-contained — works for users who installed dispatch via npm and have
# no source repo on disk. Legacy prompt_file path is still honored.
INLINE_PROMPT_PATH=""
if [ -n "$PROMPT_B64" ]; then
  INLINE_PROMPT_PATH="$LOG_DIR/$NAME-$TS.prompt.txt"
  if ! printf '%s' "$PROMPT_B64" | base64 -d > "$INLINE_PROMPT_PATH" 2>/dev/null; then
    echo "ERROR: failed to decode inlined prompt_b64" >&2
    exit 1
  fi
  PROMPT_FILE="$INLINE_PROMPT_PATH"
  echo "Decoded inlined prompt → $PROMPT_FILE"
fi

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

# For run-once schedules we need to remove the plist so it doesn't fire again
# next year (StartCalendarInterval has no year field). HOWEVER: when this
# wrapper is invoked by real launchd (the production path), running
# `launchctl unload` against the plist that started us causes launchd to
# SIGTERM the wrapper itself before the work runs.
#
# Two-phase cleanup:
#  - PRE-work: just `rm -f` the plist file. Removing the file does NOT signal
#    launchd; the in-memory job keeps running normally. If the wrapper
#    crashes after this, the next `launchctl load` (e.g. on reboot) finds no
#    file and the job is gone — no annual re-fire.
#  - POST-work: `launchctl unload -w` to clear the in-memory job. By then
#    the work is done; getting SIGTERM'd here is harmless (we're about to
#    exit anyway) but `unload` of an already-removed plist is also fine.
if [ "$RUN_ONCE" = "true" ]; then
  PLIST="$HOME/Library/LaunchAgents/com.dispatch.$NAME.plist"
  echo "=== Run-once: removing $PLIST file (pre-work) ==="
  rm -f "$PLIST"
fi

# Build the work command (one of: raw command, or `dispatch run ...`).
# Use printf %q for any field that came from user input (model, branch prefix)
# so shell metacharacters can't break the quoted command we hand to cmux/tmux.
WORK_CMD=""
if [ -n "$COMMAND_FIELD" ]; then
  WORK_CMD="$COMMAND_FIELD"
elif [ -n "$PROMPT_FILE" ]; then
  if [ ! -f "$PROMPT_FILE" ]; then
    echo "ERROR: prompt file not found: $PROMPT_FILE" >&2
    exit 1
  fi
  BRANCH_NAME="${BRANCH_PREFIX:-$NAME}-$(date +%Y%m%d-%H%M)"
  WORK_CMD=$(printf 'dispatch run --headless --no-attach --prompt-file %q --name %q' \
    "$PROMPT_FILE" "$BRANCH_NAME")
  if [ -n "$MODEL" ]; then
    WORK_CMD="$WORK_CMD $(printf '%s %q' --model "$MODEL")"
  fi
  if [ -n "$MAX_TURNS" ]; then
    WORK_CMD="$WORK_CMD $(printf '%s %q' --max-turns "$MAX_TURNS")"
  fi
else
  echo "ERROR: schedule has neither command nor inline prompt set" >&2
  exit 1
fi

# Discover the shared multiplexer target. We prefer running the work inside an
# existing cmux pane (or a shared tmux session) so the user has a single
# observable window for all scheduled fires. `dispatch _scheduled-target`
# prints one of:
#   cmux <socket-path> <workspace-id>
#   tmux <session-name>
#   none
TARGET_OUT=""
if command -v dispatch >/dev/null 2>&1; then
  TARGET_OUT=$(dispatch _scheduled-target 2>/dev/null || true)
fi
TARGET_KIND=$(printf '%s' "$TARGET_OUT" | awk '{print $1}')

# When we route work into a shared multiplexer pane, we lose the synchronous
# rc that we get from inline `bash -c "$WORK_CMD"`. To preserve real success
# accounting (so `_schedule-record-success` doesn't lie to the idempotency
# gate), we use a done-marker pattern: the work command appends `; echo $? > MARKER`
# and we poll for the marker, treating its contents as the real rc.
#
# Timeout is generous — `dispatch run --headless` exits within seconds (it
# only dispatches the agent, doesn't wait for it), but raw `command:` schedules
# could be longer. Tunable via DISPATCH_SCHEDULE_TARGET_TIMEOUT (seconds).
DONE_MARKER="$LOG_DIR/$NAME-$TS.done"
TARGET_TIMEOUT="${DISPATCH_SCHEDULE_TARGET_TIMEOUT:-600}"

# Wrap the work so its rc is captured. We use a subshell `( ... )` so any
# `exit N` inside the work doesn't kill the cmux pane's shell (which would
# trigger pane-exited cleanup and close the shared workspace).
WRAPPED_WORK=$(printf '( %s ); echo $? > %q' "$WORK_CMD" "$DONE_MARKER")

# Poll for the marker. Returns 0 on found, 1 on timeout. Reads RC into the
# global RC variable on success.
wait_for_marker() {
  local elapsed=0
  local sleep_s=1
  while [ "$elapsed" -lt "$TARGET_TIMEOUT" ]; do
    if [ -f "$DONE_MARKER" ]; then
      local read_rc
      read_rc=$(cat "$DONE_MARKER" 2>/dev/null | tr -d '[:space:]')
      if [[ "$read_rc" =~ ^[0-9]+$ ]]; then
        RC="$read_rc"
        return 0
      fi
      # Marker exists but unreadable — treat as failure rather than success.
      RC=1
      return 0
    fi
    sleep "$sleep_s"
    elapsed=$((elapsed + sleep_s))
  done
  return 1
}

RC=0
case "$TARGET_KIND" in
  cmux)
    SOCKET=$(printf '%s' "$TARGET_OUT" | awk -F'\t' '{print $2}')
    WSID=$(printf '%s' "$TARGET_OUT" | awk -F'\t' '{print $3}')
    echo "=== Routing into shared cmux workspace $WSID (socket: $SOCKET) ==="
    CMUX_CLI=$(command -v cmux 2>/dev/null || true)
    if [ -z "$CMUX_CLI" ]; then
      for c in "/Applications/cmux NIGHTLY.app/Contents/Resources/bin/cmux" \
               "/Applications/cmux.app/Contents/Resources/bin/cmux"; do
        if [ -x "$c" ]; then CMUX_CLI="$c"; break; fi
      done
    fi
    if [ -z "$CMUX_CLI" ]; then
      echo "WARN: cmux CLI not found; falling back to inline run"
      bash -c "$WORK_CMD" || RC=$?
    else
      SEND_PAYLOAD="echo '--- [scheduled:$NAME @ $(date +%H:%M:%S)] ---' && $WRAPPED_WORK"$'\n'
      if ! "$CMUX_CLI" --socket "$SOCKET" send --workspace "$WSID" "$SEND_PAYLOAD"; then
        echo "WARN: cmux send failed; falling back to inline run"
        bash -c "$WORK_CMD" || RC=$?
      else
        echo "Waiting for done-marker $DONE_MARKER (timeout ${TARGET_TIMEOUT}s)..."
        if ! wait_for_marker; then
          echo "WARN: timed out waiting for cmux pane to finish — recording as failure"
          RC=1
        else
          echo "Marker received: rc=$RC"
        fi
      fi
    fi
    ;;
  tmux)
    SESSION=$(printf '%s' "$TARGET_OUT" | awk -F'\t' '{print $2}')
    TMUX_BIN=$(printf '%s' "$TARGET_OUT" | awk -F'\t' '{print $3}')
    # Fall back to PATH lookup if dispatch didn't supply an absolute path.
    [ -z "$TMUX_BIN" ] && TMUX_BIN=$(command -v tmux 2>/dev/null || true)
    WIN_NAME="${NAME}-${TS}"
    if [ -z "$TMUX_BIN" ]; then
      echo "WARN: tmux target advertised but binary not found; falling back to inline run"
      bash -c "$WORK_CMD" || RC=$?
    else
      echo "=== Routing into shared tmux session '$SESSION' (window: $WIN_NAME) via $TMUX_BIN ==="
    # `exec bash` after the marker write keeps the window (and therefore the
    # session) alive so the user can attach and inspect output. Without it,
    # the window's process exits when the work finishes and the session
    # collapses on the last-window-out — fine for accounting (marker already
    # written) but the user has nothing to attach to.
    TMUX_INNER=$(printf 'bash -lc %q' "$WRAPPED_WORK; exec bash")
    SENT=0
    if ! "$TMUX_BIN" has-session -t "$SESSION" 2>/dev/null; then
      if "$TMUX_BIN" new-session -d -s "$SESSION" -n "$WIN_NAME" "$TMUX_INNER"; then
        SENT=1
      fi
    else
      if "$TMUX_BIN" new-window -t "$SESSION" -n "$WIN_NAME" "$TMUX_INNER"; then
        SENT=1
      fi
    fi
    if [ "$SENT" -eq 0 ]; then
      echo "WARN: tmux dispatch failed; falling back to inline run"
      bash -c "$WORK_CMD" || RC=$?
    else
      echo "Waiting for done-marker $DONE_MARKER (timeout ${TARGET_TIMEOUT}s)..."
      if ! wait_for_marker; then
        echo "WARN: timed out waiting for tmux window to finish — recording as failure"
        RC=1
      else
        echo "Marker received: rc=$RC"
      fi
    fi
    fi  # close TMUX_BIN-found branch
    ;;
  *)
    echo "=== No multiplexer available — running inline ==="
    bash -c "$WORK_CMD" || RC=$?
    ;;
esac

# Marker file is single-use; remove it so a future fire with the same TS
# can't accidentally see a stale "success." The TS already includes seconds
# so collisions are vanishingly rare, but defensive cleanup is cheap.
rm -f "$DONE_MARKER" 2>/dev/null || true

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

# Final cleanup of run-once metadata. The plist file was already removed
# pre-work; the metadata stays until here so any in-flight tooling can still
# read it. Now also unload the in-memory launchd job — done LAST because if
# launchd SIGTERMs us in response, we're about to exit anyway.
if [ "$RUN_ONCE" = "true" ]; then
  echo "=== Run-once: removing metadata $META_FILE ==="
  rm -f "$META_FILE"
  if command -v launchctl >/dev/null 2>&1; then
    LABEL="com.dispatch.$NAME"
    echo "=== Run-once: bootout/unload of $LABEL (post-work) ==="
    # Prefer the modern `bootout` API; fall back to legacy `unload -w` if it
    # isn't available. Either may SIGTERM us — that's fine, we're done.
    UID_VAL=$(id -u)
    launchctl bootout "gui/$UID_VAL/$LABEL" 2>/dev/null \
      || launchctl unload -w "$HOME/Library/LaunchAgents/$LABEL.plist" 2>/dev/null \
      || true
  fi
fi

exit "$RC"
