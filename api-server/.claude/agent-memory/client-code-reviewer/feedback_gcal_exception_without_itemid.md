---
name: gcal-exception-without-itemid
description: Client code that finds a routine item's `modified` exception by itemId alone misses every Google-inbound move (those entries carry no itemId).
metadata:
  type: feedback
---

Client code that decides "is this routine item moved/pinned?" by matching `routineExceptions` on `e.itemId === item._id` misses every move made in Google Calendar. The server's `buildExceptionEntry` (routes/calendar.ts) writes inbound `modified` entries with only date / newTimeStart / content, and no itemId. Only the client's own `recordRoutineInstanceModification` sets itemId. The server's `regenerateFutureRoutineItems` matches the moved row by `newTimeStart` instant instead (`pinnedExceptionDate`).

**Why:** this came up in the 2026-11-06 reconcile review (fix/routine-schedule-edit-reconcile). The new code re-timed Google-moved occurrences back to the template time, or deleted them when their landing date fell off the rule. Tests only seeded itemId-bearing exceptions, so they passed.

**How to apply:** whenever client code touches future routine items, check that a moved item is matched by itemId OR by `newTimeStart === item.timeStart`. Ask for a test with an itemId-less exception. Related: [[client-mirror-drops-owner-scope]], [[linked-routine-bulk-item-ops]].
