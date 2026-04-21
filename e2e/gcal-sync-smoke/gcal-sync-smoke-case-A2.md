# Case A2 — Modify a single instance time in the app

**Read first:** `gcal-sync-smoke-case-shared-preamble.md`.
**Matrix section:** A2 in `/Users/yuvalyssak/gtd/docs/CALENDAR_ROUTINE_SYNC_TESTS.md`.

## Setup
Reuse the existing routine `e2e-smoke-A1-1776757989` (weekly Mon 09:00 30m). Its next instance is Mon Apr 27 2026 at 9:00am.

If that routine no longer exists, create a fresh weekly-Mon 09:00 30m calendar routine titled `e2e-smoke-A2-<ts>` and pick any future instance at least 7 days out. Note the instance date.

## When
In the app Calendar view, click the Mon Apr 27 instance of `e2e-smoke-A1-1776757989` (or your fresh routine's next instance), open the edit dialog, change time from 09:00 → 11:00 (keep duration 30m so end = 11:30). Save.

## Then (assertions)
Wait ≤30s. Verify:
- App: that single instance now shows 11:00–11:30, other future instances stay 09:00–09:30, past items unchanged.
- GCal: the specific Mon Apr 27 occurrence on Yuval GTD Test calendar shows 11:00–11:30 as a single-instance override. Master event RRULE unchanged. Other Mondays still 9:00–9:30.
- No duplicate item appears after the sync cycle.
- **`routineExceptions` check** (per shared preamble): run the mongosh query against the routine's title. Expect exactly one entry: `date` = the overridden instance's ISO date (e.g. `2026-04-27`), `type: "modified"`, `newTimeStart` and `newTimeEnd` set to the new ISO datetimes, no `title`/`notes` on the exception. Record the block in the result notes.

## Record
Append block to `e2e/gcal-sync-smoke/session-1-results.md` with status + observations + routine title used.
