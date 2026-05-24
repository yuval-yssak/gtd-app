---
name: routine-master-attendees-propagation-partial
description: Master GCal-owned propagation to items exists via propagateMasterGCalOwnedChangesToItems, but applyModifiedExceptionToOne's bare $unset still corrupts items on exception-only sync cycles where master propagation doesn't run.
metadata:
  type: project
---

`updateRoutineFromGCal` now calls `propagateMasterGCalOwnedChangesToItems(updated, ctx)` when `gcalOwnedDelta` is true (line ~1798), plus a parallel `applyGCalOwnedRoutineDeltaOnly` (line ~2078) for the older-webhook fast path. Both write per-item $set/$unset and record ops.

**Remaining hole:** `applyModifiedExceptionToOne` (line ~2693) $unsets any GCal-owned key the exception omits AND the item carries (lines ~2707-2713). The design assumes `propagateMasterGCalOwnedChangesToItems` runs in the same sync cycle to re-mirror master values. But on a sync cycle that delivers ONLY an exception (master unchanged → not in listEventsFull diff), the order is:
1. `syncRoutineExceptions` → `applyModifiedExceptionToOne` $unsets attendees on the item
2. `importCalendarEvents` runs but master not in diff → `propagateMasterGCalOwnedChangesToItems` does NOT run
3. End state: item has NO attendees, doesn't inherit master

**Why:** This is the common "user adds a per-instance title override" path — GCal emits only an exception delta. The user surfaced a related "limitation" about exception entries dropping out entirely but missed this sibling case where the exception entry stays but stops carrying a key.

**How to apply:**
- When reviewing `applyModifiedExceptionToOne` or per-instance exception handling: the $unset must be paired with $set-from-master, not bare unset. Or guard the $unset by checking whether master propagation will run in the same cycle.
- Also flag: `propagateMasterGCalOwnedChangesToItems` lacks an `updatedTs` race guard while `applyModifiedExceptionToOne` has one — asymmetric race policy in the same feature surface.
- Tests for any future propagation path must assert that BOTH (a) item DB rows and (b) recorded `update` ops carry the new master attendees.

Related: [[create-on-miss-no-dedupe]], [[routine-instance-attendees-override-pitfall]]
