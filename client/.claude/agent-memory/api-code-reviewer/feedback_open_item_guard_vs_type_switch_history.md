---
name: open-item-guard-vs-type-switch-history
description: "At most one open routine item" guards that count every non-done/non-trash status are blocked forever by calendar-status history left behind by a calendar→nextAction routineType switch
metadata:
  type: feedback
---

When a change adds or reuses an "at most one open item" guard for a nextAction routine, check what it counts as "open". A calendar→nextAction type switch deliberately leaves PAST calendar occurrences in `status: 'calendar'` as history. A guard that only excludes `done`/`trash` sees that history as the open slot and the routine silently stops generating after the first disposal.

**Why:** 2026-10-30 review — the disposal guard added to `advanceRoutineAfterDisposal` (and the client's `hasOpenRoutineItem` disposal guard) used the narrow exclusion, while the bootstrap after the switch already ignored calendar history. Suite stayed green because no test disposes an item after a type switch.

**How to apply:** for any open-slot predicate on routines, ask for a test "switch calendar→nextAction with a past calendar item left behind, then complete the seeded item → a successor is minted". Check client and server guards together; they drift in parity.
