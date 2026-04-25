# Case F2 — Master notes edited in both app and GCal between syncs

**Read first:** shared preamble. **Matrix:** F2. Timing-dependent.

## Setup
Fresh weekly-Mon routine `e2e-smoke-F2-<ts>` with notes `F2 base notes`. Wait ≤30s.

## When
Rapidly (<2s):
1. App Routines → open `e2e-smoke-F2-<ts>` → change notes to `F2 edited in app`. Save.
2. Immediately in GCal master event → change description to `F2 edited in gcal`. Save "All events".

## Then
Wait ≤30s. Observe final notes in app Routines view and GCal master description.
- Whichever had the later `updated` wins.

## Record
Append result block.
