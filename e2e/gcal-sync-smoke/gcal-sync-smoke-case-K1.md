# Case K1 — Create calendar routine with future startDate

**Read first:** `gcal-sync-smoke-case-shared-preamble.md`.
**Matrix section:** K (startDate) — new section in `/Users/yuvalyssak/gtd-e2e-ai-driven/docs/CALENDAR_ROUTINE_SYNC_TESTS.md`.

Foundation case for the K-series. Creates a calendar routine whose startDate is in the future; verifies no items are emitted (app-side or GCal-side) before that date.

## Setup
None — K1 creates its own routine fresh.

## When
Routines page → `Create routine` →
- Title: `e2e-smoke-K1-<ts>`
- Type: `Calendar`
- Frequency: `Every day`
- **Start date: 7 days from today** (important — this is the field being tested)
- Start time: `09:00`, Duration: `30` minutes
- Ends: `Never`

Click `Create routine`. Wait ≤30s.

## Then
Verify:
- **App** — Routines list shows the routine as Active. `/calendar` shows the first item on day 7 (the startDate) — no items between today and day 6.
- **Mongo** — `db.routines.findOne({title:...})` has `startDate=<YYYY-MM-DD of day 7>`. `db.items.find({routineId: ..., status: 'calendar'})` returns only items with `timeStart >= <startDate>T00:00:00`.
- **GCal** — Targeted `find` on `<routine-title>` for the week containing today → no matches. `find` on the week containing day 7 → matches with the first occurrence on day 7 at 9:00am. The GCal master's DTSTART is the startDate (snapped forward to BYDAY/BYMONTHDAY if applicable — FREQ=DAILY needs no snap).

## Not checked
- Exact DTSTART bytes in GCal's master — tested indirectly via the first-visible-occurrence date.

## Record
Append result block under a new `### K-series (startDate)` subsection.
