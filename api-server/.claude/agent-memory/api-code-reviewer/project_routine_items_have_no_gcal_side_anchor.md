---
name: routine-items-have-no-gcal-side-anchor
description: Routine-generated items NEVER receive lastSyncedFromGCalTs/lastPushedToGCalTs from inbound sync, so any "is local newer than Google?" predicate is unsound for them
metadata:
  type: project
---

Any predicate of the form "item.updatedTs > <some GCal anchor> ⇒ the local side is newer" is
**unsound for routine-generated items**, and the failure is silent.

**Why:**
- `updateExistingCalendarItem` (routes/calendar.ts) early-returns on `if (existing.routineId) return;`
  — routine items never flow through the standalone inbound merge that stamps `lastSyncedFromGCalTs`.
- `applyModifiedExceptionToOne` — the path that DOES apply Google-side instance moves to routine
  items — writes only `updatedTs: ctx.now` (+ the changed fields). It stamps **no** GCal-side anchor.
- So after Google moves an instance, the item has `updatedTs` = server-now and no item-level anchor.
- The only fallback anchor is `routine.lastSyncedFromGCalTs`, which holds Google's `event.updated`
  — by construction an *earlier* instant than the `ctx.now` at which we applied it.

Net: `item.updatedTs > routine.lastSyncedFromGCalTs` is **permanently true** after any Google-side
instance edit. A sweep keyed on that predicate pushes Google's own state back to Google.

Compounding: `latestTs`-style reducers that max over `lastPushedToGCalTs` (local server clock) and
`lastSyncedFromGCalTs` (Google's clock) are comparing two independent clocks lexicographically.
Sub-second/second-scale margins prove nothing — see [[project_lastpushed_ts_stamped_after_await]],
where the local stamp lands *after* the awaited GCal call.

**FIXED 2026-08-08** (missed-push sweep review): `applyModifiedExceptionToOne` now sets
`lastSyncedFromGCalTs: ctx.now` in `setFields`, and `createItemForOrphanedException` stamps it on
the inserted row — so inbound-applied routine items carry `updatedTs == lastSyncedFromGCalTs` and
read as "not locally newer". `isItemUpdateNoop` destructures `lastSyncedFromGCalTs` out alongside
`updatedTs` so the noop-churn guard (the notification-storm fix) still holds. Verified end-to-end
by driving the real `applyExceptionToItems` then sweeping: Google-originated edit → 0 pushes,
genuine local edit afterwards → 1 push.

**How to apply:** when reviewing any new "re-push / heal / divergence-detect" logic that compares
`updatedTs` against a GCal anchor, first ask *does this path admit routine items?* If yes, demand
either (a) an item-level `lastPushedToGCalTs` stamp on the inbound exception-apply path, or (b) a
hard requirement for an item-level anchor with the routine-level fallback dropped. Also require a
skew tolerance (~60s) rather than a bare `>` — genuine missed pushes are minutes-to-days stale.
Verify empirically: seed an item as the inbound apply leaves it and assert no push.
Related: [[project_getexceptions_window_anchored_to_since]], [[project_gcal_perpetual_noop_routine_updates]].
