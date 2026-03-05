#!/bin/bash
# Run this from inside a cmux nightly terminal to test the integration.
set -e

DISPATCH="node $HOME/git/dispatch/dist/cli.js"

echo "=== cmux integration test ==="
echo ""

# 1. Check env vars
echo "1. Environment check"
echo "   CMUX_WORKSPACE_ID: ${CMUX_WORKSPACE_ID:-NOT SET}"
echo "   CMUX_SOCKET_PATH:  ${CMUX_SOCKET_PATH:-NOT SET}"
if [ -z "$CMUX_WORKSPACE_ID" ]; then
  echo "ERROR: Not running inside cmux."
  exit 1
fi
echo ""

# 2. Test cmux primitives
echo "2. cmux CLI test"
cmux ping && echo "   ping: OK" || echo "   ping: FAILED"
echo ""

# 3. Test dispatch detection
echo "3. dispatch detection"
$DISPATCH list --brief 2>&1 | head -5
echo ""

# 4. Test sidebar features (on current workspace)
echo "4. Testing sidebar status + log + color..."
cmux set-status dispatch "testing" --color "#F18F01" --workspace "$CMUX_WORKSPACE_ID"
cmux log --source dispatch --workspace "$CMUX_WORKSPACE_ID" -- "Test log entry from dispatch"
echo "   Check sidebar for orange 'testing' status and log entry"
sleep 2
cmux clear-status dispatch --workspace "$CMUX_WORKSPACE_ID"
echo ""

# 5. Test workspace creation
echo "5. Creating test workspace..."
git worktree remove --force .worktrees/test-cmux-integration 2>/dev/null || true
git branch -D test-cmux-integration 2>/dev/null || true
$DISPATCH run "This is a cmux test" --name test-cmux-integration --no-attach 2>&1
echo ""

echo "6. Checking dispatch list..."
sleep 2
$DISPATCH list --brief 2>&1
echo ""

# 7. Test notification
echo "7. Testing notification..."
cmux notify --title "Dispatch Test" --body "Agent test-cmux-integration finished"
echo "   Check for blue ring notification"
echo ""

# 8. Test markdown dashboard (background, kill after 5s)
echo "8. Testing markdown dashboard..."
$DISPATCH dashboard &
DASH_PID=$!
sleep 3
if [ -f .dispatch-dashboard.md ]; then
  echo "   Dashboard file created:"
  head -10 .dispatch-dashboard.md
  echo "   ..."
fi
kill $DASH_PID 2>/dev/null
rm -f .dispatch-dashboard.md
echo ""

# 9. Cleanup
echo "9. Cleaning up..."
$DISPATCH stop test-cmux-integration 2>&1
$DISPATCH cleanup test-cmux-integration --delete-branch 2>&1
echo ""

echo "=== Test complete ==="
