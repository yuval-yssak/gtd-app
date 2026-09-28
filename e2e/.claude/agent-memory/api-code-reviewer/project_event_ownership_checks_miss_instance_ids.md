---
name: event-ownership-checks-miss-instance-ids
description: Guards/lookups keyed on items.calendarEventId repeatedly forget calendarInstanceEventId (routine occurrences) and done-status owners
metadata:
  type: project
---
Recurring gap class: any "who owns this Google event id" check written against `calendarEventId` + `status:'calendar'` (mirroring the status-scoped unique index) misses (1) routine occurrence items, which carry the Google instance id in `calendarInstanceEventId` (a different, non-status-scoped index), and (2) `done` items, whose event still exists with the ✓ marker. A standalone item linked to an instance id is not rerouted by pushback (`normalizeMasterEventId` only strips `_R…`), so it patches/cancels the occurrence directly.

**Why:** seen in the 2026-09-28 review of the duplicate-calendar-item fix (PATCH 409 calendar_event_linked pre-check + GET ?calendarEventId filter) — both only matched `calendarEventId`.

**How to apply:** when reviewing any event-ownership lookup, pre-check or list filter, ask "does it also match calendarInstanceEventId and done owners?" Related: [[project_gcal_moved_row_foreign_date_class]].
