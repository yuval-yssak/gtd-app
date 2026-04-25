# Case K4 — Edit startDate backward

**Read first:** `gcal-sync-smoke-case-shared-preamble.md`.
**Matrix section:** K (startDate) in `/Users/yuvalyssak/gtd-e2e-ai-driven/docs/CALENDAR_ROUTINE_SYNC_TESTS.md`.

Opposite direction of K2/K3. User moves startDate backward (earlier than the current one). The partition-by-doneness logic is the same — the direction of the edit doesn't change the code path — but this case explicitly confirms no regression.

## Setup
Run A1 with a startDate set to **today + 30 days** (routine has no items yet since startDate is in the future). No past items to worry about.

## When
Routines page → Edit the routine → change **Start date** to **today + 3 days** (earlier than before, but still future) → Save.

## Then
Verify:
- **App (routines)** — One routine, `Active`, `startDate` = new earlier date.
- **App (/calendar)** — Items now start from the earlier startDate.
- **Mongo** — Routine has `startDate=<new earlier date>`. Items for this routine all have `timeStart >= <new startDate>`.
- **GCal** — Master's DTSTART is re-anchored at the new earlier startDate. No split, no UNTIL added.

## Known anomaly
None expected.

## Record
Append to `### K-series (startDate)` subsection.
