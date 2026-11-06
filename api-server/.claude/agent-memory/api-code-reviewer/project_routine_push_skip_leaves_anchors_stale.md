---
name: routine-push-skip-leaves-anchors-stale
description: Routines have no carry-forward; any client whole-snapshot replace reverts server-stamped lastSyncedNotes/lastPushedToGCalTs, and a push-skip optimization stops the push from re-stamping them
metadata:
  type: project
---

Routine sync apply is a whole-snapshot `replaceById` with NO carry-forward (only items have `hydrateItemCarryForwards`). `stampRoutineLastPushed` writes `lastSyncedNotes` / `lastPushedToGCalTs` on the routine row WITHOUT recording an op, so clients hold stale values and every client routine write reverts the row's anchors. Until 2026-11 this was masked because every active-routine write pushed the series and re-stamped them afterwards.

Any change that SKIPS the steady-state routine push (rank-only reorder skip, `isRankOnlyRoutineChange`, reviewed 2026-11-06; paused routines; suspended integrations) leaves the stale anchors on the row. Consequence found so far: low — `resolveInboundNotes` later sees GCal description != stale lastSyncedNotes and, once GCal is newer, rewrites notes through an html->markdown round-trip (possibly lossy formatting, not lost content).

**Why:** the push-skip class looks free ("Google never sees it"), but the push also does server bookkeeping.
**How to apply:** when a diff adds a new reason to skip routine pushback, ask what the skipped push used to re-stamp; suggest a routine carry-forward of CALENDAR_SYNC_ANCHOR_FIELDS if more skip reasons accumulate. Related: [[carry-forward-hydrator-skips-creates]].
