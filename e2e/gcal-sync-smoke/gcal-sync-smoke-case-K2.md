# Case K2 — Edit startDate forward on routine with `done` past items

**Read first:** `gcal-sync-smoke-case-shared-preamble.md`.
**Matrix section:** K (startDate) in `/Users/yuvalyssak/gtd-e2e-ai-driven/docs/CALENDAR_ROUTINE_SYNC_TESTS.md`.

Mirror of the E-series split semantics. When a user moves a routine's startDate forward AND there are past `done` items tied to it, the split gesture fires: the old routine is capped at yesterday and kept for historical reference, a new tail routine takes over from the new startDate.

## Setup
Run A1 (create calendar routine, `e2e-smoke-K2-<ts>`, FREQ=DAILY at 09:00, 30min). Wait for items to generate, then mark at least one past item as **Done** (use `/calendar` → click item → `Done`, or adjust the clock).

## When
Routines page → Edit the routine → change **Start date** to 7 days from today → Save.

## Then
Verify:
- **App** — Routines list now shows TWO routines with the same title prefix: one `Paused` (the old, capped routine) and one `Active` (the tail with the new startDate). The `done` past item(s) remain tied to the old (paused) routine.
- **Mongo** —
  - Old routine: `active=false`, rrule contains `UNTIL=<yesterday>T235959Z` (app-side cap).
  - New tail routine: `active=true`, `startDate=<new date>`, `splitFromRoutineId=<old routine _id>`, different `calendarEventId`.
  - Past `done` items still reference the old routine's `_id` in `routineId`.
- **GCal** —
  - Old master: recurrence now has `UNTIL=<yesterday>`. Past occurrences (including the `done` one) remain intact.
  - New master: a separate recurring event series whose DTSTART is the new startDate.

## Known anomaly
None expected. If this test produces a single routine (no split), the startDate-edit branch's `partitionPastItemsByDoneness` check may have misclassified — Fail.

## Record
Append to `### K-series (startDate)` subsection.
