# Case F3 — Echo suppression (app push → immediate webhook within 5s)

**Read first:** shared preamble. **Matrix:** F3. Timing-dependent.

## Setup
Fresh weekly-Mon routine `e2e-smoke-F3-<ts>`. Wait ≤30s for initial sync.

## When
Edit the routine's master title in the app to `F3 test echo` and save. Immediately (within 5s) observe both tabs.

## Then
Wait ≤30s. Verify:
- App: routine title `F3 test echo`, no duplicate routine appears, no flicker back to old title.
- GCal: master event title `F3 test echo`.
- No phantom `updatedTs` bump from echo (not UI-visible; skip).

**Echo suppression** means the inbound webhook for the just-pushed event does not get re-applied. Hard to assert from the UI alone — look for: no duplicate item, no title reverting, no extra items appearing.

## Record
Append result block. If no visible anomaly → `Pass (no observable regression)`.
