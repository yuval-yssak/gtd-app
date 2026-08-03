---
name: response-status-never-emitted-by-exception-parser
description: GCalException.responseStatus is declared but NEVER populated by buildModifiedException — any master-inheritance merge over GCal-owned keys silently clobbers per-instance RSVPs.
metadata:
  type: project
---

`GCalException.responseStatus` (`CalendarProvider.ts:41`) is a **phantom field**: declared on the
interface, threaded through `buildExceptionEntry` and `pickGCalOwnedExceptionFields`, but
`buildModifiedException` (`GoogleCalendarProvider.ts:909-925`) never emits it. No parser populates it.

**Why it matters:** any code doing `{ ...pickGCalOwnedRoutineFields(routine), ...pickGCalOwnedExceptionFields(ex) }`
resolves `responseStatus` to the MASTER's value 100% of the time. On a routine instance the user RSVP'd
individually (`POST /calendar/items/:itemId/rsvp` forks the instance on GCal), this overwrites the item's
own `responseStatus` with the series response — while `item.attendees[self].responseStatus` still holds
the correct per-instance value. The row then self-contradicts, and the contradiction is persisted +
recorded into an `update` op + fanned out to every device.

`responseStatus` is the ONE GCal-owned key that is a *self*-denormalization rather than an event property,
so it is the one key that must NOT participate in master→instance inheritance. Derive it from the merged
attendee list (`attendees.find(a => a.self)?.responseStatus`, matching `GoogleCalendarProvider.ts:327`)
or exclude it from both the `$set` and the unset-candidate list.

**How to apply:**
- Flag ANY new master∪override merge over `GCAL_OWNED_ROUTINE_KEYS` / `GCAL_OWNED_ITEM_KEYS` that does not
  special-case `responseStatus`. The merge is otherwise correct — this is the single carve-out.
- The bug is invisible to inspection because the field *looks* like it flows from GCal. Prove it by
  execution: seed routine `responseStatus:'needsAction'` + item `responseStatus:'declined'`, mock an
  exception carrying `attendees` but no `responseStatus`, sync, assert the item still reads `'declined'`.
- `client/src/components/calendarRowMetaLogic.ts:36` reads the chip from the attendees self-row, NOT from
  `item.responseStatus` — so the UI masks this. Do not accept "the UI looks fine" as evidence.

Related: [[routine-instance-attendees-override-pitfall]], [[routine-master-attendees-propagation-partial]]
