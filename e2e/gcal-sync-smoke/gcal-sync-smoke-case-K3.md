# Case K3 — Edit startDate forward on routine without `done` past items

**Read first:** `gcal-sync-smoke-case-shared-preamble.md`.
**Matrix section:** K (startDate) in `/Users/yuvalyssak/gtd-e2e-ai-driven/docs/CALENDAR_ROUTINE_SYNC_TESTS.md`.

Counter to K2. When there are no `done` past items, the startDate edit path hard-deletes past (non-done) items and updates the routine in place, re-anchoring the GCal master.

## Setup
Run A1 (create calendar routine, `e2e-smoke-K3-<ts>`, FREQ=DAILY at 09:00, 30min). Wait for items to generate. **Do NOT complete any item as Done.** Optionally trash some past items — that's fine (they're non-done).

## When
Routines page → Edit the routine → change **Start date** to 7 days from today → Save.

## Then
Verify:
- **App** — Exactly ONE routine with this title (no split). `/calendar` shows items only from the new startDate onward. Past items are gone (hard-deleted, not visible anywhere — `/inbox`, `/trash`, etc.).
- **Mongo** —
  - One routine: `active=true`, `startDate=<new date>`, same `calendarEventId` as before.
  - No items with `routineId=<this>` and `timeStart < <new startDate>`.
- **GCal** — The existing master is updated (`events.update`) to re-anchor DTSTART at the new startDate. No new master is created.

## Known anomaly
None expected. If two routines appear, the branching is incorrectly taking the split path — Fail.

## Record
Append to `### K-series (startDate)` subsection.
