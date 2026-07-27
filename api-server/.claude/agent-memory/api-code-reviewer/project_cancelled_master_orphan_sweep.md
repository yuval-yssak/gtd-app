---
name: cancelled-master-orphan-sweep
description: Phase-3 reap of successors stranded active on a cancelled GCal series — why it must run last, what "live sibling in batch" must mean, and its echo/heal interactions
metadata:
  type: project
---

`reapOrphanedSeriesSuccessors` (calendar.ts, phase 3 of `importRecurringMastersOrdered`) retires the routine left
ACTIVE on a bare series id that this batch cancelled, sparing one whose `calendarRebasedEventId` names a different
master. Fixes phantom items from a legacy successor stranded live when its bare master was cancelled (staging
2026-07-26). Reviewed over 2 rounds, 2026-07-27.

**Why phase 3 and not the cancelled branch:** phase 1 (cancelled/reReport) runs before phase 2 (`_R` successors), so an
inline sweep retires the routine phase 2 is about to claim. Empirically (probes through the real sync route):
cancelled `X` + confirmed open `X_R2` → successor killed and phase 2 mints a **twin**; cancelled `X_R1` + open `X_R2`
→ successor killed, re-anchored, and **unreactivatable** → series with zero active routines. Both reachable from a
plain full sync and from "this and all following" on a segment's FIRST occurrence (Google cancels rather than caps).

**How to apply / review checklist for this area:**
- **Deactivating with an OPEN rrule is a one-way door.** `updateRoutineFromGCal`'s only revive gate (`seriesUncapped` →
  `newlyLosesUntil`) requires `existing.rrule.includes('UNTIL=')`. Any heuristic retirement must also cap
  (`deactivateRoutineFromGCal(…, { capRruleFrom })`); direct-evidence retirements deliberately don't.
- **Batch-liveness predicate means "still produces occurrences", not "open rrule"** — `bareIdsWithLiveMasterInBatch`
  (exported, unit-tested) counts a confirmed sibling capped with a **future** UNTIL as live. Treating open-ended as the
  only live shape reaped a series alive for another 60 days (verified before the fix). A split base's past UNTIL still
  reads as dead; an unparseable UNTIL returns null → live, the safe direction.
- **Phase 3 honours `isOwnEcho(successor.lastPushedToGCalTs, master.updated)`** so it is provably a no-op on the
  pre-existing path (`findActiveRoutineOnSeries` can return a plain base phase 1 just declined to touch). Cost: a
  cancellation echo-skipped this way is only re-delivered by a full sync, since deltas never re-report it.
- **Heal endpoints:** `healSplitSuccessorRoutines` requires `!rrule.includes('UNTIL=')`, so the CAP is what keeps a
  reaped routine out of it (no flap). `healStuckGCalRoutines` matches `!active || pastUntil` and WILL strip the cap and
  revive it — this was FIXED 2026-07-27 by the `retiredByGCal` routine marker; see
  [[project_retired_by_gcal_marker_lifecycle]] for its full set/clear/skip lifecycle.
- `deactivateRoutineFromGCal` twice on one series is safe: it no-ops on `!active`, and
  `uniq_active_routine_per_gcal_series` guarantees ≤1 active row per (user, bareId, integration).
- The cancelled path is reachable ONLY from `importCalendarEvents`; `resolveMarkerRoutineGroup` filters
  `status === 'cancelled'` into `resolveGoneMarkerRoutine` before `importLiveMaster`, so the relink sweep never reaps.
- Stale `calendarRebasedEventId` makes the reap spare a dead tail; full syncs backfill/refresh the anchor via
  `findActiveRoutineOnSeries` + `rekeySuccessorRebasedId`, which is what keeps that rare.

See [[project_gcal_resplit_reanchor_e11000_fix]], [[project_gcal_resplit_rekey_and_fault_isolation]].
