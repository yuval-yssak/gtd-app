---
name: routine-instance-skip-and-silent-restamp-pitfalls
description: Skipping a routine-instance override because "item equals its slot" strands Google overrides (reopen after done, attendees, /v1 reverts); an op-less server restamp of calendarInstanceEventId is reverted by the next client snapshot
metadata:
  type: project
---

Two traps from the 2026-11-06 re-review of fix/routine-schedule-edit-reconcile. Both were proven with a probe test.

1. `routineExceptions` is NOT a complete record of which overrides Google holds. The done marker, attendee edits, /v1 and MCP edits, and reopen write no exception. Only the client editor and inbound sync do, and inbound entries carry no itemId. So "item content == routine slot && no exception" does not prove the occurrence inherits the master. Reopen after done was skipped, which left ✓ and the sage colour on Google for good. Demand a provable signal, e.g. the item was never individually pushed (`!lastPushedToGCalTs` on the hydrated snapshot).
2. Carry-forward fills only fields ABSENT from the snapshot. Client rows keep the old `calendarInstanceEventId`, so a server `$set` with no op is undone by the next client update. The following done push then targets the old id, gets a 404, and the swallowed error drops it silently. Any server re-key of a field the client also stores needs an op that is fanned out.
3. In `/sync/push`, every op in a batch is applied before any pushback runs. So an item push reads the routine AFTER a routine op in the same batch has landed. "The old exception is still there" ordering arguments do not hold.

**How to apply:** for any new "skip the Google push because nothing diverged" gate, list every write path that creates a Google-side override without leaving a local trace, and ask for a test of each.
