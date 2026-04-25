# Case B3 — Delete a single instance in GCal

**Read first:** shared preamble. **Matrix:** B3.

## Setup
Fresh weekly-Mon routine `e2e-smoke-B3-<ts>`. Wait ≤30s. Pick next future Monday.

## When
In GCal, open that Monday, click trash/delete, choose "This event only".

## Then
Wait ≤30s. Verify:
- App: that specific Monday's instance disappears from Calendar view.
- Other Mondays still present.
- Master routine remains Active.
- GCal master event still exists.

## Record
Append result block.
