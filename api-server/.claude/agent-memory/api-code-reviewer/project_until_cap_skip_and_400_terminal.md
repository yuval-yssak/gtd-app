---
name: until-cap-skip-and-400-terminal
description: "The beyond-UNTIL instance-cancellation skip trusts routine.rrule as a proxy for the GCal master's UNTIL, and 400→terminal silently widened rsvpReplay's revert path — two blind spots to re-check on any change in this area"
metadata:
  type: project
---

Shipped 2026-08-27 (staging incident 2026-08-26/27: a daily routine capped to `UNTIL=20260901T235959Z`
produced 39 syncFailed ops — 24 rate-limit 403s + 15 "Bad Request" — all rendered as endlessly-retryable
"Couldn't reach Google Calendar" rows). Two changes: `pushRoutineInstanceCancellation` skips beyond-cap
occurrences; `categorizeGCalError` buckets 400 as `terminal`.

**Why these two blind spots outlive the diff:**

1. **`routine.rrule`'s UNTIL is a PROXY for the GCal master's UNTIL, not the truth.** The skip is a
   silent no-push — no throw, no `syncFailed` op, no panel row. When the local UNTIL is stale relative
   to Google (the documented stale-UNTIL-locked-by-updatedTs-churn class, and the `_R` split base whose
   capped rrule coexists with a live successor on the same bare id), an in-app trash of a routine
   instance now leaves the GCal occurrence live FOREVER with zero user-visible signal. The pre-fix
   behaviour pushed and succeeded. `pushRoutinePause`'s `!routine.active` skip has the same shape but
   is safe because pause writes both sides in one action; the UNTIL skip has no such coupling.

2. **`categorizeGCalError` is not just the panel's label map.** It also drives `rsvpReplay`'s
   `retryWithBackoff` predicate AND its `reason === 'terminal'` → `revertLocalResponseStatus` branch.
   Moving any code into `terminal` therefore (a) removes its retries and (b) newly rolls the user's
   local RSVP chip back. Any future re-bucketing must be reasoned about at all three call sites, not
   just the SyncIssuesPanel.

**Review checklist for this area:**
- `isInvalidGrantError` runs BEFORE the numeric-code switch, so a 400 carrying `invalid_grant`
  (three observed googleapis shapes) still reaches `scope_missing`. With 400 now terminal this
  precedence is load-bearing — inverting it strands a revoked integration Dismiss-only with no
  Reconnect. NOW PINNED by "classifies a 400 carrying invalid_grant as scope_missing"; verified it
  is the ONLY test that catches hoisting the code switch above the guard.
- The skip guard lives ONLY in `pushRoutineInstanceCancellation`. `pushRoutineInstanceOverride`
  (the `done`-marker / per-instance-edit path) has no equivalent and will still 400 on a beyond-cap
  instance — reachable when a device offline during the cap later flushes a `done` op. OPEN follow-up.
- COUNT-capped series (`FREQ=DAILY;COUNT=10`) cap the master with no UNTIL, so `extractUntil` returns
  null and the guard never fires. `stripEndClauses` removes COUNT on split/cap, but imported GCal
  series can carry it. Mitigated (not fixed) by 400→terminal. OPEN follow-up.
- Day-granularity is the deliberate conservative direction: a date-only UNTIL (normalized to UTC
  midnight) with a same-day timed occurrence still pushes and surfaces terminal. The comparison is
  TZ-stable because `resolveOriginalDate` always yields `YYYY-MM-DD` and `dayjs.utc('YYYY-MM-DD')`
  is server-TZ-independent — verified under Asia/Jerusalem and America/Los_Angeles.
- The guard MUST be fed `resolveOriginalDate`, never `snapshot.timeStart`: a moved instance's rrule
  truth lives on the routine's `modified` exception, so a beyond-cap `timeStart` can hide an at-cap
  original occurrence that still exists on the master. Pinned by "judges the UNTIL cap by the
  exception original date, not the moved timeStart".
- `calendar.ts:reconcileRevivedSkippedExceptions` — the skip means a beyond-cap `skipped` exception
  has NO GCal tombstone, breaking that function's old blanket provenance claim. Its
  `routineGeneratesOccurrenceOnDate` guard (raw rrule, UNTIL included) is what independently rejects
  those dates. Docstring amended 2026-08-27 to name the carve-out and mark the guard load-bearing
  ("do not relax") — if a future change relaxes it anyway, phantom revival is the bug.

Related: [[project_gcal_403_rate_limit_is_retryable]], [[project_gcal_pushback_failure_surfacing_coverage]],
[[project_cancelled_master_orphan_sweep]], [[project_routine_items_have_no_gcal_side_anchor]].
