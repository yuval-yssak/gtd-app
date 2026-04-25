# Calendar ↔ Routine Sync Smoke Test — Session 1: Basics + Conflicts

**Status:** ready to execute in a new session. Self-contained — read top to bottom and follow.
**Estimated runtime:** ~2.5-3 hours. ~450-600k tokens.
**Scope:** Sections A, B, C, D, F of `/Users/yuvalyssak/gtd/docs/CALENDAR_ROUTINE_SYNC_TESTS.md` — 31 cases.
**Followup:** Session 2 (`gcal-sync-smoke-session-2-splits-tz-until-deactivation.md`) covers E, G, H, I.

---

## What you are doing

An **observational smoke test** of bidirectional sync between calendar-type routines in the GTD app and Google Calendar recurring events. Real local stack, real Google Calendar, **no code changes, no mocks, no test scaffolding**. You will create routines, mutate them on one side, wait for automatic sync, and verify the other side using the UI only.

## Project context (brief)

- Working directory: `/Users/yuvalyssak/gtd-e2e-ai-driven` (use this, NOT `/Users/yuvalyssak/gtd`).
- Full test matrix reference: `/Users/yuvalyssak/gtd/docs/CALENDAR_ROUTINE_SYNC_TESTS.md` (lives in sibling worktree — read it for each case's Given/When/Then).
- Project guide: `/Users/yuvalyssak/gtd-e2e-ai-driven/CLAUDE.md`.
- App architecture: offline-first React client (port 4173), Hono/Node API (port 4000), IndexedDB client store, MongoDB server store, Better Auth sessions, Google Calendar integration via `CalendarIntegration` + `CalendarSyncConfig`.
- Relevant server sync endpoints/routes live in `api-server/src/routes/calendar.ts`; services in `api-server/src/services/calendar/*`.

## Preflight — do these before any scenario (blocking)

1. **Confirm client is running** on `http://localhost:4173` (curl it; expect any 2xx/3xx/4xx, not connection refused). If down: ask user to start it with `cd client && npm run dev`. Do NOT start it yourself.
2. **Confirm API is running** on `http://localhost:4000` (curl; 404 on `/` is fine). If down: ask user to start it with `cd api-server && npm run dev`.
3. **Load Chrome MCP tools in one shot:** `ToolSearch({ query: "claude-in-chrome", max_results: 30 })`. Do NOT load individually.
4. **Open a fresh tab** via `mcp__claude-in-chrome__tabs_context_mcp` first, then `tabs_create_mcp` for the app and another for `https://calendar.google.com`.
5. **Verify app login + GCal integration connected.** Open app → Settings → Calendar Integrations. If not logged in or integration missing → stop and ask.
6. **Ask the user for the dedicated test calendar name/ID.** They requested a dedicated test calendar, not the primary. All GCal-side changes must happen on that calendar.

## Ground rules

- **Automatic sync only.** After each mutation, wait up to 30 seconds for webhook + client pull to settle. If the expected state isn't observed in 30s, mark the case `Fail` or `Timeout`. **Do NOT click "Sync now"** — that's the manual escape hatch and masks the exact automatic-path bugs this test catches.
- **UI-only assertions.** All verification via app UI and GCal UI. Fields not visible in the UI (`lastPushedToGCalTs`, `lastSyncedNotes`, `routineExceptions` internals, etc.) are marked **"not checked (not UI-visible)"** in the report. Do NOT read IndexedDB directly.
- **Unique titles per case.** Each fresh routine named `e2e-smoke-<case>-<unix-ts>`, e.g. `e2e-smoke-A1-1713456789`. Makes cleanup trivial.
- **No cleanup.** You do not delete test routines or GCal events. Cases that delete as part of the scenario (A7, B8, F6) perform deletion as the test — that's expected.
- **Stop and ask triggers:**
  - Chrome MCP tool fails 2-3 times consecutively
  - Browser unresponsive / JS dialog appears (they freeze the extension)
  - UI affordance is unclear (esp. F-series concurrent timing)
  - Sync consistently >30s across multiple cases → may indicate stack issue
- **Link safety:** Never click web links via computer-use. If a link needs following, use the Chrome MCP.
- **No "Sync now" even as diagnostic.** User explicitly decided: if auto-sync fails in 30s, it fails. Full stop.

## Execution & reporting cadence

- Run cases in order (A1 → A9, B1 → B8, C1 → C5, D1 → D3, F1 → F6).
- **Report in batches of 10 cases** with a partial results table, so the user can pull the plug early if the first batch reveals systemic issues.
- Between cases, ~3-5s settle; between sections, a brief pause.

## Scope — 31 cases

### A. App-originated routine, then app-side change (9)
- A1 Create routine + link to GCal
- A2 Modify instance time in app
- A3 Modify instance title/notes in app
- A4 Trash instance in app
- A5 Edit master title/notes in app
- A6 Change RRULE in app (triggers split — **Note:** full split semantics validated in Session 2's E-series; here just verify the field change propagates)
- A7 Delete routine in app
- A8 Complete instance in app
- A9 Offline edit then reconnect

### B. App-originated routine, then GCal-side change (8)
- B1 Modify instance time in GCal
- B2 Modify instance title/description in GCal
- B3 Delete instance in GCal
- B4 Edit master title/description in GCal
- B5 Change master RRULE in GCal
- B6 Change master time of day in GCal
- B7 Change master duration in GCal
- B8 Delete master event in GCal

### C. GCal-originated routine, then app-side change (5)
Each requires creating a recurring event in GCal first, waiting for auto-import, then mutating in the app.
- C1 Import existing GCal recurring event
- C2 Modify instance in app (GCal-originated R)
- C3 Trash instance in app (GCal-originated R)
- C4 Delete routine in app (GCal-originated R)
- C5 Edit master in app (GCal-originated R)

### D. GCal-originated routine, then GCal-side change (3)
- D1 Modify instance in GCal (GCal-originated R)
- D2 Delete master in GCal (GCal-originated R)
- D3 Move event between calendars — **matrix notes this is not implemented.** Mark `N-A`, record observed behavior.

### F. Concurrent edits / conflict resolution (6)
- F1 Same instance edited both sides
- F2 Master notes edited both sides
- F3 Echo suppression (app push → immediate webhook within 5s)
- F4 Echo window expired (app push → webhook delivery ≥5s later)
- F5 App delete instance + GCal modify same instance
- F6 App master delete + GCal concurrent instance edit

F-series require narrow-timing gestures. Flag each with `timing-dependent, flake risk` in notes. For F3/F4 specifically, use wall-clock timing: stopwatch the 5s echo window.

## Per-case procedure (apply to every case)

1. **Read the scenario** from the matrix doc for exact Given/When/Then.
2. **Set up:** create a fresh routine (app side for A/B/F; GCal side for C/D) with title `e2e-smoke-<case>-<ts>`. Note its title + approximate creation time.
3. **Perform the "When" action** exactly as described.
4. **Wait up to 30 seconds** for automatic sync.
5. **Verify "Then" assertions** via UI only. For each assertion:
   - Check app UI (Routines page, Inbox, calendar views, Settings as appropriate)
   - Check GCal UI (calendar.google.com)
   - Any assertion on a non-UI-visible field → `not checked (not UI-visible)`
6. **Record result** with status `Pass / Fail / N-A / Timeout`.
7. **Move on.** No retries, no "Sync now". 

## Pre-execution questions for the user

Ask before starting case 1:
1. Which specific GCal calendar is the "dedicated test calendar" (name or ID)?
2. Are both `cd client && npm run dev` and `cd api-server && npm run dev` running? (Verify via curl before asking.)
3. Confirm: proceed with automatic-sync-only policy, 30s cap, no "Sync now"?

## Deliverable

A single markdown report with:

### Per-section result tables (A, B, C, D, F)
Columns: `#` · `Scenario` · `Expected (1-line summary)` · `Observed` · `Pass / Fail / N-A / Timeout` · `Notes`.

### Top issues summary
5-10 bullets grouped into:
- **Load-bearing failures** (break core sync semantics)
- **Likely flakes** (timing-dependent, intermittent)
- **Design-decision gaps** — cross-reference these open questions from the matrix doc (section at end):
  - #1 routine-delete vs integration-delete (relevant to A7)
  - #2 `lastSyncedNotes` for exceptions (relevant to B2)
  - #3 in-place update vs regenerate on RRULE change (relevant to B5/B6)
  - #4 cross-calendar move (relevant to D3)
  - #9 outbound push during `needsReauth` (not covered here — flag for Session 2)

### Cleanup checklist
All test routines + GCal events created, table with:
- App-side title
- GCal event URL (if obtainable from Chrome tab)
- Status at end of run (active / trashed / series-deleted / deactivated)
- User's delete path (delete routine in app → master event auto-deletes per A7 if it passed)

**Do not delete anything. Leave the list for the user.**

## Starting the session — suggested first message

When the user starts a fresh Claude session, suggest they open with:

> Execute the plan at `e2e/gcal-sync-smoke/gcal-sync-smoke-session-1-basics.md`. Start with the preflight checks.
