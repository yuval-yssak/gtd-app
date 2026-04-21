# Case C5 — Edit master content in app (GCal-originated routine)

**Read first:** shared preamble. **Matrix:** C5 (like A5 but GCal-origin).

## Setup
Create fresh GCal-originated routine `e2e-smoke-C5-<ts>` with initial description `C5 original GCal notes`. Wait for import.

## When
App Routines page → open → rename title to `e2e-smoke-C5-<ts> — app edit` and change notes to `C5 edited in app`. Save.

## Then
Wait ≤30s. Verify:
- App: future Monday instances show new title and notes.
- GCal: master event title + description updated.

## Record
Append result block.
