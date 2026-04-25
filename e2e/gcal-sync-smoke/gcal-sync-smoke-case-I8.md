# Case I8 — App-side resume via new startDate

**Read first:** `gcal-sync-smoke-case-shared-preamble.md`.
**Matrix section:** I (Routine deactivation / pause) in `/Users/yuvalyssak/gtd-e2e-ai-driven/docs/CALENDAR_ROUTINE_SYNC_TESTS.md`.

Complement to I7. A paused calendar routine is resumed by the user opening the edit dialog, setting a new `startDate`, and saving. The app flips `active=true`, GCal master's UNTIL is cleared, and future items regenerate from the new startDate.

## Setup
Must run **after I7**. The paused routine from I7 is the input.

## When
Routines page → click the **Resume** (play) button OR the Edit button on the paused routine → in the dialog:
- Enter a **Start date** (≥ today; a few days ahead works).
- Leave other fields alone.
- Click `Save changes`.

Wait ≤30s.

## Then
Verify:
- **App (routines)** — Routine row shows `Active` chip again (Pause button present, Resume button gone). Banner on the edit dialog is gone.
- **App (/calendar)** — Calendar view shows items starting from the new startDate onward (respecting the rrule's BYDAY/BYMONTHDAY).
- **Mongo** — `db.routines.findOne({title:...})` has `active=true`, `startDate=<the new date>`, `calendarEventId` unchanged from before. `db.items.find({routineId: ...})` has fresh future items on/after `startDate` (no items before).
- **GCal** — Targeted `find` on `<routine-title>` for the week containing the new startDate and subsequent weeks. The master series's recurrence must:
  - No longer carry `UNTIL=<pre-resume date>` (the cap from I7).
  - Emit new occurrences on and after the startDate.

## Known anomaly (flag, don't fail)
If the resume dialog's startDate doesn't match the rrule's BYDAY (e.g. startDate=Tuesday but rrule BYDAY=MO), GCal may emit a phantom occurrence on the startDate in addition to the correct weekly occurrences. Same root-cause as A1's anomaly — DTSTART-off-BYDAY. Mark Pass-with-anomaly.

## Not checked
- Intermediate GCal state between the cap-strip patch and the regen — may show a brief window of no items.

## Record
Append result to the same `I-series` subsection as I7.
