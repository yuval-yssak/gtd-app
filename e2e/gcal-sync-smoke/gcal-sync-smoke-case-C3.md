# Case C3 — Trash instance in app (GCal-originated routine)

**Read first:** shared preamble. **Matrix:** C3 (like A4).

## Setup
Reuse C1 routine or create fresh GCal-originated routine `e2e-smoke-C3-<ts>`, wait for import.

## When
Pick next future Monday in app Calendar → trash that instance.

## Then
Wait ≤30s. Verify:
- App: that Monday gone. Others present.
- GCal: that Monday deleted. Master + other Mondays present.

## Record
Append result block.
