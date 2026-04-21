# Case B7 — Change master duration in GCal

**Read first:** shared preamble. **Matrix:** B7.

## Setup
Fresh weekly-Mon 09:00 30m routine `e2e-smoke-B7-<ts>`. Wait ≤30s.

## When
In GCal, open any Monday, change end time so duration is 60m (e.g. 9:00–10:00). Save with "All events".

## Then
Wait ≤30s. Verify:
- App Routines page: routine duration now 60m (reads "for 1h" or equivalent).
- App Calendar: future Monday items now 09:00–10:00.
- GCal: master event duration 60m.

## Record
Append result block.
