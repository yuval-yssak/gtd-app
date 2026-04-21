# Case B8 — Delete master event in GCal (series cancellation)

**Read first:** shared preamble. **Matrix:** B8.

## Setup
Fresh weekly-Mon routine `e2e-smoke-B8-<ts>`. Wait ≤30s for GCal sync.

## When
In GCal, open any Monday → click trash → delete → "All events".

## Then
Wait ≤30s. Verify:
- App Routines page: routine status changes. Record whether it's marked Inactive / deactivated / removed.
- App Calendar: future Monday items trashed / gone.
- Past items (if any exist in state `done` or `timeStart < now`) should remain — verify.
- GCal: master series gone.

## Record
Append result block. Record exact app-side status (Active vs Inactive vs deleted).
