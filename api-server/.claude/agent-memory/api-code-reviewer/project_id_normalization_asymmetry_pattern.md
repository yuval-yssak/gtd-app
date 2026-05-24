---
name: id-normalization-asymmetry-pattern
description: Recurring class of bug — normalize-on-write fixes that miss the comparison/read sites silently re-create the same bug from the opposite direction. Demand symmetric coverage on every identity-comparison codepath.
metadata:
  type: project
---

When a GCal (or other external-system) id has multiple equivalent forms (e.g. `<masterId>` vs `<masterId>_R<YYYYMMDDTHHMMSS>` for rebased recurring masters), a fix that normalizes the WRITE side without simultaneously normalizing every COMPARISON site is fragile: the bug recurs from the opposite direction (storage bare, inbound suffixed → still misses).

**Why:** Reviewed the rebased-master id fix (`normalizeMasterEventId`) on `main`. The fix correctly normalizes `routine.calendarEventId` on import + creation paths and provides a backfill. But three identity-comparison sites were left raw:
- `calendar.ts:1374` `knownRoutineEventIds.has(e.id)` — `e.id` may bear `_R<...>` for cancelled rebased masters
- `calendar.ts:1393` `routineEventIds.has(e.recurringEventId)` — instances of a rebased master legitimately report `recurringEventId = <base>_R<...>`
- `GoogleCalendarProvider.ts:717` `event.recurringEventId !== eventId` — caller passes now-bare `routine.calendarEventId`; if GCal returns suffixed `recurringEventId`, exceptions silently drop on the floor (no error, no log — pure data loss)

The most damaging variant is the silent-no-op in `getExceptions`: produces no operations, no error, nothing to debug. Just divergence from GCal truth.

**How to apply:** On any fix that normalizes/transforms an id at write time:
1. Grep every read-side comparison (`.has(`, `=== id`, `findOne({field: id})`, `{$in: ids}`) for the same field.
2. Apply the same transform on the inbound side of the comparison, or on both sides.
3. Demand a regression test that proves the silent-failure direction would fail without the fix.
4. Check disconnect markers too — `lastKnown*` fields are copies of the same id and need the same transform; the backfill must cover them.

Related: [[project_lastknown_marker_orphan_risk]], [[project_calendar_restore_ordering_pitfall]].
