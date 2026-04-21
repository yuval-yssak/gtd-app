# Case A8 — Complete a single instance (calendar routine)

**Read first:** `gcal-sync-smoke-case-shared-preamble.md`.
**Matrix section:** A8.

## Setup
Create fresh weekly-Mon routine `e2e-smoke-A8-<ts>`. Wait ≤30s for GCal sync. Pick an instance you can complete — if today is Monday use today, otherwise advance to the next Monday item or use whichever item has a "Complete" affordance. If no affordance on future items, stop and ask.

## When
In the app, complete that specific instance (mark done).

## Then
Wait ≤30s. Verify:
- App: instance now has `done` status. Future items unchanged.
- GCal: that occurrence still present on the calendar (completion is a GTD-local concept; GCal has no "done" state). Master event unchanged.
- Routine's other instances unchanged.

## Record
Append result block.
