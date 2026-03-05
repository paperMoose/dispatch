#!/bin/bash
# Run this from inside a cmux nightly terminal in a git repo with a dev branch.
# Don't use set -e — we test commands that may fail
set +e

DISPATCH="node $HOME/git/dispatch/dist/cli.js"
AGENT_NAME="test-cmux-$(date +%s | tail -c 5)"

echo "=== cmux integration test (v0.6.0) ==="
echo ""

# 1. Check env vars
echo "1. Environment check"
echo "   CMUX_WORKSPACE_ID: ${CMUX_WORKSPACE_ID:-NOT SET}"
echo "   CMUX_SOCKET_PATH:  ${CMUX_SOCKET_PATH:-NOT SET}"
if [ -z "$CMUX_WORKSPACE_ID" ]; then
  echo "ERROR: Not running inside cmux."
  exit 1
fi
echo "   OK"
echo ""

# 2. Test cmux primitives
echo "2. cmux CLI test"
cmux ping && echo "   ping: OK" || echo "   ping: FAILED"
echo ""

# 3. Test sidebar features (on current workspace)
echo "3. Testing sidebar status + log + color..."
cmux set-status dispatch "testing" --color "#F18F01" --icon "bolt.fill" --workspace "$CMUX_WORKSPACE_ID"
cmux log --source dispatch --workspace "$CMUX_WORKSPACE_ID" -- "Test log entry from dispatch"
echo "   Check sidebar for status and log entry"
sleep 2
cmux clear-status dispatch --workspace "$CMUX_WORKSPACE_ID"
echo "   OK"
echo ""

# 4. Test new primitives: set-hook, trigger-flash, find-window, pipe-pane, set-progress
echo "4. Testing new cmux primitives..."
echo "   set-hook:"
cmux set-hook --workspace "$CMUX_WORKSPACE_ID" test-hook "echo hook-fired" 2>&1 && echo "     OK" || echo "     FAILED"
echo "   trigger-flash:"
cmux trigger-flash --workspace "$CMUX_WORKSPACE_ID" 2>&1 && echo "     OK" || echo "     FAILED"
echo "   set-progress:"
cmux set-progress 0.5 --workspace "$CMUX_WORKSPACE_ID" --label "Test 50%" 2>&1 && echo "     OK" || echo "     FAILED"
sleep 1
cmux clear-progress --workspace "$CMUX_WORKSPACE_ID" 2>&1
echo "   find-window:"
cmux find-window --content "cmux integration test" 2>&1 && echo "     OK" || echo "     FAILED"
echo ""

# 5. Test dispatch detection
echo "5. dispatch detection"
$DISPATCH list --brief 2>&1 | head -5
echo ""

# 6. Test dispatch find (search)
echo "6. dispatch find"
$DISPATCH find "integration test" 2>&1
echo ""

# 7. Test workspace creation + prompt delivery
echo "7. Creating test workspace: $AGENT_NAME"
$DISPATCH run "List the files in this directory, then say DONE." --name "$AGENT_NAME" --base main --no-attach 2>&1
echo ""

# 8. Wait for agent to initialize
echo "8. Waiting for agent to start..."
sleep 5

# 9. Check dispatch list finds it
echo "9. dispatch list"
$DISPATCH list --brief 2>&1
echo ""

# 10. Check the workspace has the marker file
ROOT=$(git rev-parse --show-toplevel)
MARKER="$ROOT/.worktrees/$AGENT_NAME/.dispatch-cmux-workspace"
if [ -f "$MARKER" ]; then
  echo "10. Marker file: OK ($(cat $MARKER))"
else
  echo "10. Marker file: MISSING at $MARKER"
fi
echo ""

# 11. Test notification + flash
echo "11. Testing notification + flash..."
cmux notify --title "Dispatch Test" --body "Agent $AGENT_NAME test notification"
# Flash the agent's workspace
AGENT_WS=$(cat "$MARKER" 2>/dev/null)
if [ -n "$AGENT_WS" ]; then
  cmux trigger-flash --workspace "$AGENT_WS" 2>&1 && echo "   flash on agent tab: OK" || echo "   flash on agent tab: FAILED"
fi
echo ""

# 12. Test stop (should close cmux tab)
echo "12. Stopping agent..."
$DISPATCH stop "$AGENT_NAME" 2>&1
echo ""

# 13. Verify tab closed
echo "13. Checking if tab closed..."
sleep 1
$DISPATCH list --brief 2>&1 || echo "   (no agents — expected)"
echo ""

# 14. Cleanup
echo "14. Cleaning up..."
$DISPATCH cleanup "$AGENT_NAME" --delete-branch 2>&1
echo ""

echo "=== Test complete ==="
echo ""
echo "Manual checks:"
echo "  - Did the agent tab appear in cmux sidebar?"
echo "  - Was the sidebar status colored (green for running)?"
echo "  - Did the prompt get delivered (agent started working)?"
echo "  - Did 'dispatch stop' close the tab?"
echo "  - Did trigger-flash light up the tab? (step 4 + 11)"
echo "  - Did set-progress show a progress bar? (step 4)"
echo "  - Did find-window return results? (step 4 + 6)"
