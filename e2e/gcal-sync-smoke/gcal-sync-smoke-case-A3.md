# Case A3 — Modify instance title/notes in the app

**Read first:** `gcal-sync-smoke-case-shared-preamble.md`.
**Matrix section:** A3.

## Setup
Create a fresh weekly-Mon 09:00 30m calendar routine titled `e2e-smoke-A3-<ts>`. Wait ≤30s for GCal sync to create the master series. Pick the next future Monday instance.

## When
In the app Calendar view, open that instance's edit dialog. Change:
- title to `e2e-smoke-A3-<ts> — edited title`
- notes to `A3 instance notes (markdown: **bold** word)`
Save.

## Then
Wait ≤30s. Verify:
- App: that single instance shows the new title and notes. Master routine's own title/notes unchanged (go to Routines page to check).
- GCal: click that specific occurrence on Yuval GTD Test. Title shows edited value; description shows the bold word rendered (GCal stores as HTML).
- Other instances (other Mondays) still show the routine's original title and empty notes.
- **`routineExceptions` check** (per shared preamble): run the mongosh query against the routine's title. Expect exactly one entry: `date` = the overridden instance's ISO date, `type: "modified"`, `title` and `notes` set to the new values (raw markdown preserved in `notes`), no `newTimeStart`/`newTimeEnd`. Record the block in the result notes.

## Record
Append result block to session results file.
