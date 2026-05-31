---
name: e11000-reresolve-status-unfiltered-finder
description: E11000 race-loser re-resolve must use a finder scoped to the same predicate as the violated index, else it can return a dead twin instead of the live winner
metadata:
  type: project
---

When an insert collides on a unique *partial* index and the catch path re-resolves the "race winner" to merge into, the re-resolve finder MUST be scoped to the same predicate as the violated index. Otherwise it can return a different row sharing the key but outside the index predicate (e.g. a `trash`/`done` row that legitimately keeps `calendarEventId`), and the merge no-ops on that dead row while the actual live winner is left untouched and no item is created.

**Why:** The codebase keeps `calendarEventId` on trashed/done calendar items (for revive via `findCalendarItemByEventId`). The `uniq_calendar_item_per_event` index is partial on `status:'calendar'`, so an E11000 means another *live* row exists — but `findCalendarItemByEventId` queries `{user, calendarEventId}` with NO status filter and returns `[0]` arbitrarily, so it can hand back the trashed twin. Contrast the much more careful `handleOrphanInsertDuplicate`/`isDemotableDeadTwin` path for the `calendarInstanceEventId` index, which explicitly distinguishes live-winner vs dead-twin.

**How to apply:** On any new E11000-catch-and-re-resolve path, check the finder's filter matches the index's `partialFilterExpression`. Tests that seed only the live winner (no competing trash/done row with the same key) will pass spuriously and hide this — demand a test fixture with a coexisting trashed row sharing the key. Relates to [[project_create_on_miss_no_dedupe]] and [[project_calendar_restore_ordering_pitfall]].
