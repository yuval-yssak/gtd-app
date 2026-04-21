# Case B5 — Change master RRULE in GCal

**Read first:** shared preamble. **Matrix:** B5.

## Setup
Fresh weekly-Mon routine `e2e-smoke-B5-<ts>`. Wait ≤30s for GCal sync.

## When
In GCal, open any Monday occurrence → "Edit event" → change recurrence from "Weekly on Monday" to "Weekly on Tuesday". Save with "All events".

If GCal requires splitting into "This and following" — note which option was available and pick whichever approximates "change the whole series going forward".

## Then
Wait ≤30s. Verify:
- App Routines page: routine frequency now reads "Every Tue at 09:00 for 30m" (or equivalent).
- App Calendar: future items shifted from Mondays to Tuesdays. Past items unchanged.
- GCal: master event pattern now Tue.

## Record
Append result block. Note which "save scope" GCal offered.
