# Case D3 — Move master event to a different calendar

**Read first:** shared preamble. **Matrix:** D3. Matrix flags this as **not implemented** — mark `N-A` and record observed behavior.

## Setup
Fresh GCal-originated routine `e2e-smoke-D3-<ts>` on the Yuval GTD Test primary calendar. Wait for import.

You'll need a second GCal calendar. If the user's only synced calendar is primary, you cannot test the cross-calendar move. Stop and ask the user whether they have a second calendar to enable. If not → mark `N-A (no secondary calendar available)`.

## When
If a second synced calendar exists: in GCal, open the master event → move/copy to the other calendar.

## Then
Wait ≤30s. Verify and record:
- App: does the routine disappear, stay, get duplicated, or get relinked?
- GCal: does the event appear on the new calendar only, both, or neither?

## Record
Append result block. Expected status: `N-A` for "not implemented" per matrix.
