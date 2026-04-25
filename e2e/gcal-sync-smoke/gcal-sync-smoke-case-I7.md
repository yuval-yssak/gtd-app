# Case I7 — App-side pause (calendar routine)

**Read first:** `gcal-sync-smoke-case-shared-preamble.md`.
**Matrix section:** I (Routine deactivation) in `/Users/yuvalyssak/gtd-e2e-ai-driven/docs/CALENDAR_ROUTINE_SYNC_TESTS.md`.

Under the new pause semantics (routine pause+startDate feature), the user can pause a calendar routine from the app's Routines list. Unlike I1 (GCal master deleted → `R.active=false`), the app-side pause keeps the GCal master intact but caps it with `UNTIL=<yesterday>`, preserving past occurrences.

## Setup
A linked calendar routine. Re-run A1 (create calendar routine, e.g. `e2e-smoke-I7-<ts>`, `FREQ=DAILY` or `FREQ=WEEKLY;BYDAY=MO`), then wait for horizon generation to produce at least 3 future calendar items.

## When
Routines page → click the **Pause** (pause icon) button next to the routine → confirm the "Pause routine?" dialog.

## Then
Verify:
- **App (routines)** — Routine row shows `Paused` chip. Pause button is replaced by a **Resume** (play) button. Editing the routine shows the "This routine is paused. Set a new start date and save to resume it." banner.
- **App (/calendar)** — All future generated items for this routine are gone from the Calendar view.
- **Mongo (baseline)** — `db.routines.findOne({title:...})` has `active=false`, `calendarEventId` still present (not null/undefined). `db.items.find({routineId: ..., status: {$in: ['calendar','nextAction']}, timeStart: {$gte: todayIso}})` is empty. Past `status='done'` items remain.
- **GCal** — Targeted `find` on `<routine-title>` for any **future** week. The master series must be capped: no occurrences after today. Any pre-existing past occurrences remain intact on previous days.
  - Verify via GCal "edit event → recurrence rule" that the rrule now carries `UNTIL=<today-1>T235959Z` (or no further occurrences visible on Google's UI).
- **No duplicate series** — GCal must NOT have a deleted-then-recreated master; the `calendarEventId` in Mongo stays the same.

## Not checked (not UI-visible)
- The exact UNTIL clause in the app's stored rrule (server pushback edit on GCal only — stored rrule on the routine is unchanged locally; only GCal's copy is capped).

## Record
Append a result block to `session-2-E-results.md` under a new `### I-series (pause/resume)` subsection, or append to Session 2 splits-tz file per the shared preamble. Flag any case where the GCal series is deleted rather than capped as a Fail (that's the old I1 semantics, not the new pause behavior).
