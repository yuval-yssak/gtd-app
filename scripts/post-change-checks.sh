#!/bin/bash
# Runs validation pipelines for whichever projects have changed files.
# Invoked as a Claude Code Stop hook — exits 1 to bounce control back to Claude on failure.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHANGED=$(git -C "$REPO_ROOT" diff --name-only HEAD 2>/dev/null)

# Nothing changed — nothing to check
if [ -z "$CHANGED" ]; then
    exit 0
fi

CLIENT_CHANGED=$(echo "$CHANGED" | grep "^client/")
API_CHANGED=$(echo "$CHANGED" | grep "^api-server/")

FAILED=0

if [ -n "$CLIENT_CHANGED" ]; then
    echo "=== Client checks ==="
    cd "$REPO_ROOT/client" || exit 1

    npm run generate-typed-css-modules || { echo "❌ generate-typed-css-modules failed"; FAILED=1; }
    npm run lint:fix || { echo "❌ lint:fix failed"; FAILED=1; }
    npm run typecheck || { echo "❌ typecheck failed"; FAILED=1; }
    npm run test || { echo "❌ test failed"; FAILED=1; }

    [ $FAILED -eq 0 ] && echo "✅ Client checks passed — invoke the code-reviewer agent next"
fi

if [ -n "$API_CHANGED" ]; then
    echo "=== API server checks ==="
    cd "$REPO_ROOT/api-server" || exit 1

    npm run lint:fix || { echo "❌ lint:fix failed"; FAILED=1; }
    npm run typecheck || { echo "❌ typecheck failed"; FAILED=1; }
    npm run test || { echo "❌ test failed"; FAILED=1; }

    [ $FAILED -eq 0 ] && echo "✅ API server checks passed — invoke the code-reviewer agent next"
fi

exit $FAILED
