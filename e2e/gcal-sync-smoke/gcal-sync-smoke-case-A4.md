# Case A4 — Trash a single instance in the app

**Read first:** `gcal-sync-smoke-case-shared-preamble.md`.
**Matrix section:** A4.

## Setup
Create fresh weekly-Mon routine `e2e-smoke-A4-<ts>`. Wait ≤30s for GCal sync. Pick the next future Monday instance.

## When
In the app Calendar view, find that instance and trash it (via its edit dialog → Move to Trash, or an explicit trash control).

## Then
Wait ≤30s. Verify:
- App: that specific Monday's instance disappears from the Calendar view. Other Mondays still present.
- GCal: search for the routine title. The specific Monday occurrence is gone (deleted/cancelled) while master series and other Mondays remain.
- Routine remains Active.
- **`routineExceptions` check** (per shared preamble): run the mongosh query against the routine's title. Expect exactly one entry: `date` = the trashed instance's ISO date, `type: "skipped"`. `itemId` may or may not be present. Record the block in the result notes.

## Record
Append result block.
