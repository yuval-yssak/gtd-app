# Case K5 — Edit startDate to past UNTIL

**Read first:** `gcal-sync-smoke-case-shared-preamble.md`.
**Matrix section:** K (startDate) in `/Users/yuvalyssak/gtd-e2e-ai-driven/docs/CALENDAR_ROUTINE_SYNC_TESTS.md`.

Edge case: setting startDate past the routine's `UNTIL` boundary. The schedule produces no occurrences; `seriesStartDate` throws. The server pushback must log and no-op rather than raising — otherwise a single bad edit crashes the worker.

## Setup
Run A1 with **Ends: On date** set to today + 14 days, FREQ=DAILY. The routine has a UNTIL boundary.

## When
Routines page → Edit the routine → change **Start date** to today + 30 days (past the UNTIL) → Save.

## Then
Verify:
- **App (routines)** — The save succeeds. Routine row shows `startDate=<today+30>`.
- **App (/calendar)** — No items (rrule produces no valid occurrences).
- **Mongo** — Routine has `startDate=<today+30>`. No items with `routineId=<this>` and `timeStart > today`.
- **GCal** — No error in the server log; master exists but produces no future occurrences in GCal either (since startDate > UNTIL). It's OK if the master's DTSTART is unchanged from before — the pushback gracefully skipped the re-anchor.
- **Server log** — Look for a pushback warning along the lines of "no occurrences on or after <startDate>" or similar. No 500-level stack trace.

## Known anomaly
A strict pushback that throws instead of logging is a regression — Fail in that case.

## Record
Append to `### K-series (startDate)` subsection. Note whether the GCal master remained or was altered.
