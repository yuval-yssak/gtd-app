# Case A1 — Create calendar routine in app, link to GCal

**Read first:** `gcal-sync-smoke-case-shared-preamble.md`.
**Matrix section:** A1 in `/Users/yuvalyssak/gtd/docs/CALENDAR_ROUTINE_SYNC_TESTS.md`.

This is the foundational case: every other A-series case depends on the "create routine app-side, expect GCal master event to appear" path working. Run it first when the session starts.

## Setup
None — A1 creates its own routine fresh. Pick a unique unix timestamp (`date +%s`) for the title.

## When
Routines page → `Create routine` →
- Title: `e2e-smoke-A1-<ts>`
- Type: `Calendar`
- Frequency: `Specific days of the week`, Mon only
- Start time: `09:00`, Duration: `30` minutes
- Ends: `Never`

Click `Create routine`. Wait ≤30s.

## Then
Verify:
- **App** — Routines list shows `e2e-smoke-A1-<ts>` (Calendar, Active, "Every Mon at 09:00 for 30m"). `/calendar` shows Mon items starting from the next Monday onward, each 9:00–9:30am.
- **Mongo (baseline, read-only)** — `db.routines.findOne({title: ...})` returns a doc with `rrule="FREQ=WEEKLY;BYDAY=MO"`, `calendarEventId` present, `active=true`, `routineExceptions` absent or null. `db.items.find({title: ...})` returns one `status="calendar"` item per future Monday through the horizon.
- **GCal** — Navigate to `https://calendar.google.com/calendar/u/2/r/week/<next-Mon-YYYY>/<M>/<D>` (no leading zeros). Targeted `find` for `<routine-title> event on Monday … at 9am` must match on `Yuval GTD Test` calendar. Repeat the `find` on the following Monday's week URL to confirm the series (not just one occurrence).
- **No duplicate routine** — The app's Routines list must show exactly one row for this title after the sync cycle (echo suppression on `lastPushedToGCalTs` — not UI-visible, don't check directly).

## Known anomaly (flag, don't fail)
If `createdTs` falls on a non-Monday (e.g. today is Wed), GCal will also render an **extra one-off occurrence on the creation day** at the same time, in addition to the correct Monday occurrences. The app's `/calendar` view does **not** show this extra day. Root cause: the GCal master event's DTSTART = `createdTs` regardless of BYDAY, so GCal emits the first occurrence from DTSTART even when BYDAY doesn't match. **This is a known write-side defect** (see A1's original Pass-with-anomaly entry in `session-1-results.md`). Record it, but still mark Pass-with-anomaly, not Fail.

Fix direction (not executed here): the GCal-master creation should snap DTSTART to the first BYDAY-matching date on or after `createdTs`.

## Not checked (not UI-visible)
- `R.calendarIntegrationId`, `R.calendarSyncConfigId`, `R.lastPushedToGCalTs` — server plumbing, not surfaced in UI.
- Echo-suppression mechanics on the webhook round-trip.

## Record
Append result block to `e2e/gcal-sync-smoke/session-1-results.md` per the shared preamble format. Mark as `Pass-with-anomaly` if the creation-day extra occurrence is present on GCal (expected on any weekday that isn't a Monday). Mark as `Pass` only if the run lands on the BYDAY itself (then no anchor artifact appears).
