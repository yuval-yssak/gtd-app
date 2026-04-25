# Case B1 — Modify instance time in GCal

**Read first:** `gcal-sync-smoke-case-shared-preamble.md`.
**Matrix:** B1.

## Setup
Create fresh weekly-Mon 09:00 30m routine `e2e-smoke-B1-<ts>` in app. Wait ≤30s for GCal sync. Pick next future Monday.

## When
In GCal (`/u/2/`), find that Monday's occurrence, open it, change time 9:00 → 11:00, save with "This event only".

## Then
Wait ≤30s. Verify:
- App Calendar view: that specific Monday now 11:00–11:30. Other Mondays still 9:00.
- GCal: that Monday shows 11:00; master unchanged.
- No duplicate item / no echo back to GCal (only one override visible).

## Record
Append result block.
