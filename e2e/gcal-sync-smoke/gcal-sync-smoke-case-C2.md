# Case C2 — Modify instance in app (GCal-originated routine)

**Read first:** shared preamble. **Matrix:** C2 (identical to A2 but routine originated in GCal).

## Setup
Run case C1 first (or create a fresh GCal-originated routine `e2e-smoke-C2-<ts>` the same way) and wait for import.

## When
Pick the next future Monday instance in the app Calendar. Edit time 10:00 → 12:00 (duration stays 45m → end 12:45). Save.

## Then
Wait ≤30s. Verify:
- App: that Monday now 12:00–12:45. Others unchanged.
- GCal: that specific Monday now 12:00–12:45 override. Master unchanged.

## Record
Append result block.
