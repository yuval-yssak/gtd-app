# Case B6 — Change master event time of day in GCal

**Read first:** shared preamble. **Matrix:** B6.

## Setup
Fresh weekly-Mon 09:00 30m routine `e2e-smoke-B6-<ts>`. Wait ≤30s.

## When
In GCal, open any Monday occurrence, change start time 09:00 → 10:00 (keep duration 30m). Save with "All events".

## Then
Wait ≤30s. Verify:
- App Routines page: routine reads "Every Mon at 10:00 for 30m" (or equivalent).
- App Calendar: future Monday items shifted to 10:00–10:30. Past items unchanged.
- GCal: master event now 10:00.

## Record
Append result block.
