#!/bin/bash
# Runs validation pipelines for whichever projects have changed files.
# Invoked as a Claude Code Stop hook — exits 2 + writes to stderr on failure so Claude
# Code re-invokes the model with the failure reason (exit 1 is silently ignored).
# Client / API server / e2e blocks run in parallel; each block's output is captured to a
# temp file and printed sequentially at the end so failure messages stay readable.
#
# Every block runs under one wall-clock budget (HOOK_BUDGET_SECONDS). A healthy run takes well
# under it (client ≈ 20s, one e2e spec ≈ 15s); a block that hits the cap is reported as a failure,
# because slow checks are a defect to fix (too many specs, a dead local service, lost concurrency),
# not something to wait out.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK_BUDGET_SECONDS="${GTD_HOOK_BUDGET_SECONDS:-90}"

# Sentinel written by a PostToolUse hook on Edit/Write/NotebookEdit: one edited file path per line.
# If absent, Claude didn't edit any files this turn (pure Q&A, read-only, etc.) so skip checks.
SENTINEL="$REPO_ROOT/.claude/.edited-this-turn"
if [ ! -f "$SENTINEL" ]; then
    exit 0
fi
# Repo-relative paths edited this turn (the hook records absolute paths).
EDITED_THIS_TURN=$(sed "s|^$REPO_ROOT/||" "$SENTINEL" | sort -u)
rm -f "$SENTINEL"

CHANGED=$(git -C "$REPO_ROOT" diff --name-only HEAD 2>/dev/null)
# Untracked files are not in `git diff HEAD`; this turn's edits cover the new ones.
CHANGED=$(printf '%s\n%s\n' "$CHANGED" "$EDITED_THIS_TURN" | grep -v '^$' | sort -u)

# Edits happened but net diff is empty (edited then reverted) — nothing to check
if [ -z "$CHANGED" ]; then
    exit 0
fi

CLIENT_CHANGED=$(echo "$CHANGED" | grep "^client/")
API_CHANGED=$(echo "$CHANGED" | grep "^api-server/")
E2E_CHANGED=$(echo "$CHANGED" | grep "^e2e/")
# Specs that failed or timed out on an earlier turn; rerun until they pass (see run_e2e).
PENDING_SPECS="$REPO_ROOT/.claude/.e2e-pending-specs"
[ -s "$PENDING_SPECS" ] && E2E_CHANGED=$(printf '%s\n(pending specs)\n' "$E2E_CHANGED")

# tmp files for captured output — cleaned up on exit
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# Background jobs get their own process group, so a deadline can kill a block together with every
# child it spawned (npm, vitest workers, Playwright browsers, the dev servers it started).
set -m

run_client() {
    local out="$TMPDIR/client.log"
    {
        echo "=== Client checks ==="
        cd "$REPO_ROOT/client" || return 1
        local rc=0
        npm run generate-typed-css-modules || { echo "❌ generate-typed-css-modules failed"; rc=1; }
        npm run lint:fix || { echo "❌ lint:fix failed"; rc=1; }
        npm run lint:css || { echo "❌ lint:css (stylelint token gate) failed"; rc=1; }
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
        # Specs edited THIS turn plus any spec that has not passed since it last ran — not every
        # spec in the uncommitted diff, which on a long branch would rerun the same specs every turn
        # and blow the budget. Deleted specs are dropped: Playwright exits non-zero
        # ("No tests found") on a path that no longer exists.
        local specs
        specs=$(
            {
                echo "$EDITED_THIS_TURN" | grep '^e2e/.*\.spec\.ts$' | sed "s|^e2e/||"
                [ -f "$PENDING_SPECS" ] && cat "$PENDING_SPECS"
            } | sort -u | while read -r spec; do [ -f "$spec" ] && echo "$spec"; done
        )
        if [ -n "$specs" ]; then
            # Recorded BEFORE the run and cleared only on a pass, so a failure or a timeout (which
            # kills this block mid-run) carries the specs into the next turn even when that turn's fix
            # lands in app code and touches no spec.
            echo "$specs" >"$PENDING_SPECS"
            # shellcheck disable=SC2086
            if npx playwright test --retries=0 $specs; then
                rm -f "$PENDING_SPECS"
            else
                echo "❌ test failed"
                rc=1
            fi
        else
            echo "(no .spec.ts files edited this turn — skipping playwright run)"
        fi
        [ $rc -eq 0 ] && echo "✅ E2E checks passed"
        return $rc
    } >"$out" 2>&1
}

# Starts a block in the background under the shared deadline. A watchdog kills the block's whole
# process group when the budget runs out and leaves a marker so the report can say why it failed.
start_with_deadline() {
    local name="$1"
    shift
    "$@" &
    local pid=$!
    (
        sleep "$HOOK_BUDGET_SECONDS"
        if kill -0 "$pid" 2>/dev/null; then
            touch "$TMPDIR/$name.timedout"
            # SIGINT first: Playwright starts its dev servers in their own process group, so only its
            # own Ctrl-C handling stops them — killing our group outright would orphan them on the e2e
            # ports (4100/4273, e2e/helpers/env.ts) and fail the next run's startup.
            kill -INT -- "-$pid" 2>/dev/null
            for _ in 1 2 3 4 5 6 7 8 9 10; do
                kill -0 "$pid" 2>/dev/null || exit 0
                sleep 1
            done
            kill -KILL -- "-$pid" 2>/dev/null
        fi
    ) &
    # Globals, not output: a $(...) caller would run the jobs in a subshell it cannot wait on.
    JOB_PID=$pid
    JOB_WATCHDOG=$!
}

# Waits for a block, stops its watchdog, and returns the block's exit status (124 on timeout).
wait_for_block() {
    local name="$1" pid="$2" watchdog="$3"
    wait "$pid"
    local rc=$?
    # The watchdog is its own process group (set -m); kill the group so its `sleep` goes too.
    kill -- "-$watchdog" 2>/dev/null
    wait "$watchdog" 2>/dev/null
    if [ -f "$TMPDIR/$name.timedout" ]; then
        echo "❌ $name checks timed out after ${HOOK_BUDGET_SECONDS}s — something is too slow (a dead local service, too many specs, lost concurrency); fix that, do not raise the budget" >>"$TMPDIR/$name.log"
        return 124
    fi
    return $rc
}

CLIENT_JOB=""
API_JOB=""
E2E_JOB=""
if [ -n "$CLIENT_CHANGED" ]; then
    start_with_deadline client run_client
    CLIENT_JOB="$JOB_PID $JOB_WATCHDOG"
fi
if [ -n "$API_CHANGED" ]; then
    start_with_deadline api run_api
    API_JOB="$JOB_PID $JOB_WATCHDOG"
fi
if [ -n "$E2E_CHANGED" ]; then
    start_with_deadline e2e run_e2e
    E2E_JOB="$JOB_PID $JOB_WATCHDOG"
fi

CLIENT_RC=0
API_RC=0
E2E_RC=0
# shellcheck disable=SC2086 # the job strings are "<pid> <watchdog pid>", split on purpose
[ -n "$CLIENT_JOB" ] && { wait_for_block client $CLIENT_JOB; CLIENT_RC=$?; }
# shellcheck disable=SC2086
[ -n "$API_JOB" ] && { wait_for_block api $API_JOB; API_RC=$?; }
# shellcheck disable=SC2086
[ -n "$E2E_JOB" ] && { wait_for_block e2e $E2E_JOB; E2E_RC=$?; }

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
