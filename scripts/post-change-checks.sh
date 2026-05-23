#!/bin/bash
# Runs validation pipelines for whichever projects have changed files.
# Invoked as a Claude Code Stop hook — exits 2 + writes to stderr on failure so Claude
# Code re-invokes the model with the failure reason (exit 1 is silently ignored).
# Client / API server / e2e blocks run in parallel; each block's output is captured to a
# temp file and printed sequentially at the end so failure messages stay readable.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Sentinel touched by a PostToolUse hook on Edit/Write/NotebookEdit. If absent,
# Claude didn't edit any files this turn (pure Q&A, read-only, etc.) so skip checks.
SENTINEL="$REPO_ROOT/.claude/.edited-this-turn"
if [ ! -f "$SENTINEL" ]; then
    exit 0
fi
rm -f "$SENTINEL"

CHANGED=$(git -C "$REPO_ROOT" diff --name-only HEAD 2>/dev/null)

# Edits happened but net diff is empty (edited then reverted) — nothing to check
if [ -z "$CHANGED" ]; then
    exit 0
fi

CLIENT_CHANGED=$(echo "$CHANGED" | grep "^client/")
API_CHANGED=$(echo "$CHANGED" | grep "^api-server/")
E2E_CHANGED=$(echo "$CHANGED" | grep "^e2e/")

# tmp files for captured output — cleaned up on exit
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

run_client() {
    local out="$TMPDIR/client.log"
    {
        echo "=== Client checks ==="
        cd "$REPO_ROOT/client" || return 1
        local rc=0
        npm run generate-typed-css-modules || { echo "❌ generate-typed-css-modules failed"; rc=1; }
        npm run lint:fix || { echo "❌ lint:fix failed"; rc=1; }
        npm run typecheck || { echo "❌ typecheck failed"; rc=1; }
        npm run test || { echo "❌ test failed"; rc=1; }
        [ $rc -eq 0 ] && echo "✅ Client checks passed — invoke the client-code-reviewer agent next"
        return $rc
    } >"$out" 2>&1
}

run_api() {
    local out="$TMPDIR/api.log"
    {
        echo "=== API server checks ==="
        cd "$REPO_ROOT/api-server" || return 1
        local rc=0
        npm run lint:fix || { echo "❌ lint:fix failed"; rc=1; }
        npm run typecheck || { echo "❌ typecheck failed"; rc=1; }
        npm run test || { echo "❌ test failed"; rc=1; }
        [ $rc -eq 0 ] && echo "✅ API server checks passed — invoke the api-code-reviewer agent next"
        return $rc
    } >"$out" 2>&1
}

run_e2e() {
    local out="$TMPDIR/e2e.log"
    {
        echo "=== E2E checks ==="
        cd "$REPO_ROOT/e2e" || return 1
        local rc=0
        npm run lint:fix || { echo "❌ lint:fix failed"; rc=1; }
        # Only run specs that actually changed in this diff — full suite is too slow for a stop hook.
        local changed_specs
        changed_specs=$(echo "$E2E_CHANGED" | grep '\.spec\.ts$' | sed "s|^e2e/||")
        if [ -n "$changed_specs" ]; then
            # shellcheck disable=SC2086
            npx playwright test --retries=0 $changed_specs || { echo "❌ test failed"; rc=1; }
        else
            echo "(no .spec.ts files changed — skipping playwright run)"
        fi
        [ $rc -eq 0 ] && echo "✅ E2E checks passed"
        return $rc
    } >"$out" 2>&1
}

CLIENT_PID=""
API_PID=""
E2E_PID=""

if [ -n "$CLIENT_CHANGED" ]; then
    run_client &
    CLIENT_PID=$!
fi
if [ -n "$API_CHANGED" ]; then
    run_api &
    API_PID=$!
fi
if [ -n "$E2E_CHANGED" ]; then
    run_e2e &
    E2E_PID=$!
fi

CLIENT_RC=0
API_RC=0
E2E_RC=0

[ -n "$CLIENT_PID" ] && { wait "$CLIENT_PID"; CLIENT_RC=$?; }
[ -n "$API_PID" ]    && { wait "$API_PID";    API_RC=$?; }
[ -n "$E2E_PID" ]    && { wait "$E2E_PID";    E2E_RC=$?; }

[ -f "$TMPDIR/client.log" ] && cat "$TMPDIR/client.log"
[ -f "$TMPDIR/api.log" ]    && cat "$TMPDIR/api.log"
[ -f "$TMPDIR/e2e.log" ]    && cat "$TMPDIR/e2e.log"

FAILED_BLOCKS=()
[ $CLIENT_RC -ne 0 ] && FAILED_BLOCKS+=("client")
[ $API_RC -ne 0 ]    && FAILED_BLOCKS+=("api-server")
[ $E2E_RC -ne 0 ]    && FAILED_BLOCKS+=("e2e")

if [ ${#FAILED_BLOCKS[@]} -gt 0 ]; then
    # Exit 2 + stderr is the Claude Code Stop-hook contract for "block the turn":
    # only exit 2 re-invokes Claude; only stderr is surfaced back to the model.
    {
        echo ""
        echo "=== STOP HOOK FAILED ==="
        echo "The following block(s) failed: ${FAILED_BLOCKS[*]}"
        echo "Scroll up for the captured logs from each block."
        echo "Fix every reported failure (and any Biome lint warnings) before considering the turn complete."
    } >&2
    exit 2
fi

exit 0
