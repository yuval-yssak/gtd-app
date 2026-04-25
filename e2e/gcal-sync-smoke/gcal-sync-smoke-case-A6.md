# Case A6 — Change the routine's RRULE in the app

**Read first:** `gcal-sync-smoke-case-shared-preamble.md`.
**Matrix section:** A6.

Note: this triggers a "this and following" split. Full split semantics are validated in Session 2 E-series; here just verify the RRULE change propagates.

## Setup
Create fresh weekly-Mon routine `e2e-smoke-A6-<ts>`. Wait ≤30s for GCal sync.

## When
Routines page → open `e2e-smoke-A6-<ts>` → change frequency to weekly Tuesday (deselect Mon, select Tue). Save.

## Then
Wait ≤30s. Verify:
- App: Routines list now shows either one routine with updated "Every Tue at 09:00 for 30m", OR two routines (original capped + new tail weekly Tue). Record which. Items page shows future items on Tuesdays, not Mondays.
- GCal: search routine title. Future occurrences are now on Tuesdays; Mondays are absent from today forward. Either one master event updated, or original master gets UNTIL and a new master appears — record which.

## Record
Append result block. Flag which split strategy the app uses (in-place vs split chain).
