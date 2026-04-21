# Case B4 — Edit master title/description in GCal

**Read first:** shared preamble. **Matrix:** B4.

## Setup
Fresh weekly-Mon routine `e2e-smoke-B4-<ts>` with initial notes `initial B4 notes`. Wait ≤30s for GCal sync.

## When
In GCal, open any Monday occurrence, edit title to `B4 master edit` and description to `<i>italic master notes</i>`. Save with "All events" / "This and following events" → pick **"All events"** if available.

## Then
Wait ≤30s. Verify:
- App Routines page: routine's title now `B4 master edit`, notes show italic formatting in any markdown preview.
- App Calendar view: all future Monday instances show the new title and propagated notes.
- Per-instance overrides (none in this case) would be preserved — N/A.

## Record
Append result block.
