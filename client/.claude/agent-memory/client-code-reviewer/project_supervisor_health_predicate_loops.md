---
name: supervisor-health-predicate-loops
description: Repair/retry supervisors (connectionSupervisor + repairRetrier) wedge on an un-deadlined step or retry forever on a health predicate that includes permanently-failing conditions
metadata:
  type: project
---

When a "keep repairing until healthy" loop is introduced (first seen 2026-11-16, feat/durable-sync
connectionSupervisor), two failure shapes come with it:

1. **Shared in-flight pass + un-deadlined step = permanent wedge.** Overlapping `repair()` calls join
   one pending pass, so a single step that never settles (bare `fetch` with no deadline,
   `navigator.serviceWorker.ready` when the SW never installs, push subscribe) silently disables every
   later repair. The pass-level unit tests used `hangs()` only to show earlier steps still ran, never
   that a SECOND repair proceeds. The e2e missed it because Notification permission is `default` in
   Playwright, so the push step returned early.
2. **Health predicate counts things no retry can fix.** `areAccountsCaughtUp` excluded reauth-flagged
   accounts, but `areLiveChannelsUp` did not — a reauth account's SSE 401s → CLOSED forever →
   billed reconnect every 2 min per tab for the tab's lifetime. Same for a push step that rejects
   permanently (Brave push disabled).

**Why:** the loop's correctness argument ("a failed step is retried") silently assumes every step
settles and every unhealthy state is transient.

3. **Making a helper throw so the supervisor retries leaks into user-gesture callers.** Turning
   `fetchVapidConfig`/`registerPushEndpoint` 5xx into throws (re-review, 2026-11-16) also hit the
   Settings `useTransition` action (React 19 rethrows a rejected async action to the error boundary)
   and NotificationNudge's un-caught onClick. Grep every caller of a helper whose failure mode changed.

**How to apply:** for any supervisor/retrier, check (a) every awaited step has a deadline or the
pass bounds each step, with a test that a hung step does not block the next repair; (b) every term
of `isRepaired`/`isCaughtUp` excludes states only a user action fixes (reauth, permission,
unsupported browser). Related: [[sync-deadline-vs-unbounded-payload]], [[request-loop-outlives-session-gate]].
