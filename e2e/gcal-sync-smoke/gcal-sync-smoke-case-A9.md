# Case A9 — Offline edit, then reconnect

**Read first:** `gcal-sync-smoke-case-shared-preamble.md`.
**Matrix section:** A9.

## Setup
Create fresh weekly-Mon routine `e2e-smoke-A9-<ts>`. Wait ≤30s for GCal sync. Pick the next future Monday instance.

## When
1. Go offline in the browser (DevTools → Network → "Offline"), or use `mcp__claude-in-chrome__javascript_tool` to toggle `navigator.onLine` with an event dispatch, or simpler: stop the API server briefly — but that's shared state. Preferred: DevTools Offline checkbox.

   If offline simulation is non-trivial via Chrome MCP, ask user to toggle DevTools Offline in the app tab.

2. With network disabled, edit that instance's time 09:00 → 10:00. Save.
3. Confirm change is visible in app (IndexedDB accepted it).
4. Restore network.

## Then
Wait ≤30s after reconnect. Verify:
- App: instance still shows 10:00–10:30.
- GCal: that specific Monday now shows 10:00–10:30 override, other Mondays unchanged.
- No conflicts or error banners in the app.
- **`routineExceptions` check** (per shared preamble): run the mongosh query against the routine's title. Expect exactly one entry: `date` = the overridden instance's ISO date, `type: "modified"`, `newTimeStart` + `newTimeEnd` set (shape identical to A2). This confirms the queued offline op reached the server after reconnect, not just the local IndexedDB write. Record the block in the result notes.

## Record
Append result block. Call out any complications with offline simulation.
