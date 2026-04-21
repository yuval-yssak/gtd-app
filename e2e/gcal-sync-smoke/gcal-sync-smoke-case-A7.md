# Case A7 — Delete routine in the app

**Read first:** `gcal-sync-smoke-case-shared-preamble.md`.
**Matrix section:** A7.

Open question #1 from the matrix: does app-side routine delete also delete the GCal master event, or just unlink? Record observed behavior either way.

## Setup
Create fresh weekly-Mon routine `e2e-smoke-A7-<ts>`. Wait ≤30s for GCal sync. Confirm series appears in GCal.

## When
Routines page → open `e2e-smoke-A7-<ts>` → Delete. Confirm any confirmation prompt.

## Then
Wait ≤30s. Verify:
- App: routine gone from Routines list. Future items gone from Calendar view. Any past/done items from this routine — record whether they survived.
- GCal: search by title. Does the master series still exist? Record the observed outcome (deleted / unlinked / orphaned). This determines matrix open question #1.

## Record
Append result block. Explicitly state whether GCal master is deleted or survives.
