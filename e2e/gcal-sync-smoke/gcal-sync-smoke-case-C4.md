# Case C4 — Delete routine in app (GCal-originated routine)

**Read first:** shared preamble. **Matrix:** C4 (like A7 but GCal-origin).

## Setup
Create fresh GCal-originated routine `e2e-smoke-C4-<ts>` (see C1 setup), wait for import.

## When
App Routines page → open `e2e-smoke-C4-<ts>` → Delete.

## Then
Wait ≤30s. Verify:
- App: routine gone. Future items gone.
- GCal: record whether master event deleted or survives (should match A7 outcome regardless of origin).

## Record
Append result block.
