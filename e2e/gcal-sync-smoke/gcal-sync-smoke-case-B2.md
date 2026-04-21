# Case B2 — Modify instance title/description in GCal

**Read first:** shared preamble. **Matrix:** B2.

## Setup
Create fresh weekly-Mon routine `e2e-smoke-B2-<ts>`. Wait ≤30s. Pick next future Monday.

## When
In GCal, open that occurrence, change title to `B2 edited` and add an HTML description `<b>bold B2 notes</b>`. Save as "This event only".

## Then
Wait ≤30s. Verify:
- App: that instance shows `B2 edited` as title, notes rendered as bold (markdown conversion).
- Master routine's title/notes on Routines page unchanged.
- Other Monday instances unchanged.

## Record
Append result block.
