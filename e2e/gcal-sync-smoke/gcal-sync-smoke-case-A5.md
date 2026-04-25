# Case A5 — Edit master title/notes in the app

**Read first:** `gcal-sync-smoke-case-shared-preamble.md`.
**Matrix section:** A5.

## Setup
Create fresh weekly-Mon routine `e2e-smoke-A5-<ts>` with an initial notes value `initial notes`. Wait ≤30s for GCal sync.

## When
Go to Routines page → open `e2e-smoke-A5-<ts>` → edit dialog:
- change title to `e2e-smoke-A5-<ts> — renamed`
- change notes to `updated master notes`
Save.

## Then
Wait ≤30s. Verify:
- App: all future Monday instances show the new title. Their notes also show `updated master notes` (propagation to generated items).
- GCal: master event title updated. Future occurrences (open any one) show new title + new description.
- If you happened to also have a per-instance override from an earlier case on this routine, it keeps its custom notes — N/A here since this is a fresh routine.

## Record
Append result block.
