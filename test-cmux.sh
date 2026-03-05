#!/bin/bash
# Run this from inside a cmux nightly terminal in a git repo with a dev branch.
# Don't use set -e — we test commands that may fail
set +e

DISPATCH="node $HOME/git/dispatch/dist/cli.js"
AGENT_NAME="test-cmux-$(date +%s | tail -c 5)"

echo "=== cmux integration test (v0.5.6) ==="
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
cmux set-status dispatch "testing" --color "#F18F01" --workspace "$CMUX_WORKSPACE_ID"
cmux log --source dispatch --workspace "$CMUX_WORKSPACE_ID" -- "Test log entry from dispatch"
echo "   Check sidebar for status and log entry"

# Test workspace color — try different approaches
echo "   Testing tab color..."
cmux workspace-action --action set-color --workspace "$CMUX_WORKSPACE_ID" --title "#44BBA4" 2>&1 && echo "   workspace-action set-color: OK" || echo "   workspace-action set-color: FAILED"
cmux workspace-action --action color --workspace "$CMUX_WORKSPACE_ID" --title "#44BBA4" 2>&1 && echo "   workspace-action color: OK" || echo "   workspace-action color: FAILED"
cmux workspace-action --action set-tab-color --workspace "$CMUX_WORKSPACE_ID" --title "#44BBA4" 2>&1 && echo "   workspace-action set-tab-color: OK" || echo "   workspace-action set-tab-color: FAILED"
# List available capabilities
echo "   workspace/color/tab capabilities:"
cmux capabilities 2>&1 | grep -iE "workspace|color|theme|tab" || echo "   (none found)"

sleep 2
cmux clear-status dispatch --workspace "$CMUX_WORKSPACE_ID"
echo ""

# 4. Test dispatch detection
echo "4. dispatch detection"
$DISPATCH list --brief 2>&1 | head -5
echo ""

# 5. Test workspace creation + prompt delivery
echo "5. Creating test workspace: $AGENT_NAME"
$DISPATCH run "List the files in this directory, then say DONE." --name "$AGENT_NAME" --no-attach 2>&1
echo ""

# 6. Wait for agent to initialize
echo "6. Waiting for agent to start..."
sleep 5

# 7. Check dispatch list finds it
echo "7. dispatch list"
$DISPATCH list --brief 2>&1
echo ""

# 8. Check the workspace has the marker file
ROOT=$(git rev-parse --show-toplevel)
MARKER="$ROOT/.worktrees/$AGENT_NAME/.dispatch-cmux-workspace"
if [ -f "$MARKER" ]; then
  echo "8. Marker file: OK ($(cat $MARKER))"
else
  echo "8. Marker file: MISSING at $MARKER"
fi
echo ""

# 9. Test notification
echo "9. Testing notification..."
cmux notify --title "Dispatch Test" --body "Agent $AGENT_NAME test notification"
echo "   Check for notification"
echo ""

# 10. Test stop (should close cmux tab)
echo "10. Stopping agent..."
$DISPATCH stop "$AGENT_NAME" 2>&1
echo ""

# 11. Verify tab closed
echo "11. Checking if tab closed..."
sleep 1
$DISPATCH list --brief 2>&1 || echo "   (no agents — expected)"
echo ""

# 12. Cleanup
echo "12. Cleaning up..."
$DISPATCH cleanup "$AGENT_NAME" --delete-branch 2>&1
echo ""

echo "=== Test complete ==="
echo ""
echo "Manual checks:"
echo "  - Did the agent tab appear in cmux sidebar?"
echo "  - Was the tab colored (green for running)?"
echo "  - Did the prompt get delivered (agent started working)?"
echo "  - Did 'dispatch stop' close the tab?"
