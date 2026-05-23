---
name: calendar-restore-ordering-pitfall
description: Calendar upsert/restore wiring must check cancelled/past/!rrule guards BEFORE running a relink/restore — otherwise we restore-then-trash and emit redundant ops.
metadata:
  type: project
---

When wiring a new relink/restore step (e.g. `tryRestoreFromLastKnownEventId`, `tryRelinkNakedCalendarItem`) into `upsertCalendarItem` or `findExistingRoutineForEvent`, the restore call must be gated on `event.status !== 'cancelled'`, `!isPastEvent(event, cutoff)`, and (for routines) `rrule != null`. Running restore before these guards causes a restore op to be written and then immediately followed by a trash/deactivate op for the same entity in the same sync — wasted ops, brief status flap visible to other devices, ops-log noise.

**Why:** The Q1 lastKnownCalendar* restore was originally wired before the cancelled/past guards with the comment "so the restored item flows through the same branches as a never-unlinked item". Functionally correct, but produces double ops for any inbound event that's stale. The pre-existing `findExistingRoutineForEvent` already documented this principle: "Skips the naked search for cancelled events (no rrule available, and there is nothing to relink to)" — and the restore initially violated it by running before the `!rrule` short-circuit.

**How to apply:** When reviewing any new relink/restore wired into the calendar inbound path, check that it is gated AFTER the cancelled/past/!rrule short-circuits, and demand tests for the three skip cases (cancelled, past, no-rrule). Look for restore-then-trash double ops in the test assertions.
