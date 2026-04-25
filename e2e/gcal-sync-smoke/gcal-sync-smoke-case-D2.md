# Case D2 — Delete master in GCal (GCal-originated routine)

**Read first:** shared preamble. **Matrix:** D2 (like B8 but GCal-origin).

## Setup
Fresh GCal-originated routine `e2e-smoke-D2-<ts>`. Wait for import.

## When
GCal → open any Monday → delete → "All events".

## Then
Wait ≤30s. Verify:
- App Routines: routine Inactive/deactivated/removed.
- App Calendar: future items gone.
- GCal: series gone.

## Record
Append result block.
