---
name: gcal-resplit-rekey-and-fault-isolation
description: Second GCal "this-and-following" re-split minted colliding twin → double-E11000 wedged whole integration sync for days; fixed by active-series rekey + per-series fault isolation
metadata:
  type: project
---

Staging GCal sync deterministically jammed for days when a series was "this and all following"-split a SECOND time.

**Root cause chain:** GCal mints a NEW `_R<anchor>` per split, so the successor routine's stored `calendarRebasedEventId` (or none, for legacy pre-rollout successors) goes stale → `findSplitSuccessorByRebasedId` misses → old `existing?.active` fallback was DEAD CODE (`findExistingRoutineForEvent`'s base-only preference always returns the capped inactive base whenever a rebased-keyed successor exists) → phase 2 inserted a colliding twin → E11000 on `uniq_active_routine_per_gcal_series` → `createRoutineFromGCal` catch re-resolved via `findExistingRoutineForEvent` → got the capped base → `updateRoutineFromGCal` `newlyLosesUntil` reactivated it → SECOND uncaught E11000 from replaceById → whole integration sync aborted BEFORE plain-event upserts (importRecurringMastersOrdered runs at ~L2119, upsertCalendarItem tombstones at ~L2136) → cancellation tombstones for UNRELATED items never applied + syncToken never advanced → every retry replayed the crash.

**Fix (calendar.ts, shipped worktree fix-gcal-split-successor-jam):**
- `findActiveRoutineOnSeries(bareId)` resolves the single active routine (index guarantees ≤1); phase-2 fallback rekeys via `rekeySuccessorRebasedId` (targeted `$set calendarRebasedEventId + updatedTs`, NOT replaceById, to preserve same-cycle routineExceptions) then updates in place. Backfills legacy + re-keys re-splits.
- E11000 recovery in `createRoutineFromGCal` now `findActiveRoutineOnSeries(...) ?? findExistingRoutineForEvent(...)` — active winner first so it never reactivates the capped base into a second collision.
- `importRecurringMasterIsolated` wraps each master import in try/catch (console.error + skip) — one broken series can't wedge the integration.
- `findExistingRoutineForEvent` base-only preference now excludes `splitFromRoutineId` too (legacy successors lack calendarRebasedEventId), so phase 1's bare capped master can't cap the live legacy successor.

**Reviewed & Approved 2026-07-21.** 4 pieces coherent; ordering verified (routine import strictly before tombstone upserts, only insertOne callsite is inside the isolated path). See [[heal-updated-ts-bump-clobbers-concurrent-edits]] — rekey bumps updatedTs but gate is anchored on lastSyncedFromGCalTs not updatedTs, so no GCal lockout; residual: rekey's updatedTs bump is a plumbing-only write that could in theory LWW-clobber a concurrent client edit before updateRoutineFromGCal re-reads (low risk, calendar routines rarely client-edited).
