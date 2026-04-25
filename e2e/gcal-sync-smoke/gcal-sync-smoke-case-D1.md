# Case D1 — Modify instance in GCal (GCal-originated routine)

**Read first:** shared preamble. **Matrix:** D1 (like B1 but GCal-origin).

## Setup
Fresh GCal-originated routine `e2e-smoke-D1-<ts>` (see C1 setup), wait for import.

## When
In GCal, open next future Monday, change time 10:00 → 13:00 (keep 45m), save as "This event only".

## Then
Wait ≤30s. Verify:
- App: that Monday 13:00–13:45. Others unchanged.
- GCal: that Monday override. Master unchanged.

## Record
Append result block.
