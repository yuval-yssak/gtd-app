# Case C1 — Import existing GCal recurring event as a routine

**Read first:** shared preamble. **Matrix:** C1.

## Setup
None in the app.

## When
In GCal (`/u/2/`), create a new recurring event:
- Title: `e2e-smoke-C1-<ts>`
- Start: next Monday 10:00
- Duration: 45m
- Repeat: Weekly on Monday
- Description: `imported from GCal`
- Calendar: Yuval GTD Test
Save.

## Then
Wait ≤30s. Verify:
- App Routines page: a new routine `e2e-smoke-C1-<ts>` appears with type Calendar, "Every Mon at 10:00 for 45m".
- App Calendar: future Monday items at 10:00–10:45 with notes `imported from GCal` (or markdown form).
- No duplicate event appears in GCal after import.

## Record
Append result block.
