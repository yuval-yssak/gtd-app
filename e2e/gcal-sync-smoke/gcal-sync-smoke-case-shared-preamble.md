# Shared Preamble for Per-Case GCal ↔ Routine Smoke Tests

All per-case plans reference this file. Read it fully once at the start of each case.

## Context
- Working dir: `/Users/yuvalyssak/gtd-e2e-ai-driven`
- GTD app runs at `http://localhost:4173`, API at `http://localhost:4000`. User starts them; don't start yourself.
- Full matrix reference: `/Users/yuvalyssak/gtd/docs/CALENDAR_ROUTINE_SYNC_TESTS.md` (read the specific case's Given/When/Then).
- Project guide: `/Users/yuvalyssak/gtd-e2e-ai-driven/CLAUDE.md`
- The GTD app is already connected to the Google account `yuval.gtd.test@gmail.com`.
- Target calendar: **primary** on `yuval.gtd.test@gmail.com` (per user: dedicated test calendar = primary on this account).

## GCal URL policy
**Always** use `https://calendar.google.com/calendar/u/2/r?pli=1` (account /u/2 = `yuval.gtd.test@gmail.com`). Never `/u/0/` or `/u/1/` — those are different accounts.

## Preflight (runs once at session start)
1. `curl -s -o /dev/null -w "%{http_code}" http://localhost:4173` → any non-000 response means it's up. Ask user to start if not.
2. `curl -s -o /dev/null -w "%{http_code}" http://localhost:4000` → same. Ask user to start if not.
3. Load Chrome MCP tools in one shot: `ToolSearch({ query: "claude-in-chrome", max_results: 30 })`.
4. Call `mcp__claude-in-chrome__tabs_context_mcp({ createIfEmpty: true })` to get tab IDs.
5. Open the app tab at `http://localhost:4173` and a second tab at `https://calendar.google.com/calendar/u/2/r?pli=1`.
6. Screenshot the app tab. Confirm it shows the GTD sidebar (Inbox, Next Actions, …). If it shows the login screen → stop, ask user to sign in.
7. Screenshot the GCal tab. Confirm left sidebar shows "Yuval GTD Test" calendar checked. If on a different account → stop.

## Ground rules (all cases)
- **Automatic sync only, 30s cap.** After each mutation wait ≤30s. If not observed → mark `Fail` or `Timeout`. Never click "Sync now".
- **UI-only assertions, with one carve-out:** `R.routineExceptions` (see below). Everything else non-UI-visible → `not checked (not UI-visible)`.
- **Unique titles:** `e2e-smoke-<case>-<ts>` where ts is `date +%s`.
- **No cleanup.** Leave everything for the user.
- **Stop and ask:** if any Chrome MCP tool fails 2-3 times, or browser/JS dialog freezes the extension, or UI affordance is unclear.
- **wait action:** `mcp__claude-in-chrome__computer wait` caps at 10s; call twice back-to-back for 20s waits. Don't use `sleep` in Bash — it's blocked long.

## routineExceptions check (mongosh, read-only)
For any case that mutates a single instance (A2/A3/A4/A9, F-series instance edits), also verify the server-side `routineExceptions` row was written. This is the one carve-out from UI-only assertions — a per-instance override that doesn't hit MongoDB is a latent bug even if the UI looks right.

Run this read-only query after the "Then" UI assertions:

```bash
mongosh "mongodb://127.0.0.1:27017/gtd_dev" --quiet --eval \
  'JSON.stringify(db.routines.findOne({title: "<routine-title>"}, {title:1, routineExceptions:1}), null, 2)'
```

Expected shape per case:
- **A2 (instance time edit):** one entry, `date` = overridden instance ISO date, `type: "modified"`, `newTimeStart` + `newTimeEnd` present. No `title`/`notes`.
- **A3 (instance title/notes edit):** one entry, `date` = overridden instance ISO date, `type: "modified"`, `title` + `notes` present. No `newTimeStart`/`newTimeEnd`.
- **A4 (instance trashed):** one entry, `date` = trashed instance ISO date, `type: "skipped"`. `itemId` may be present.
- **A9 (offline instance edit):** same as A2 once reconnected.

Record the observed `routineExceptions` block verbatim in the result notes. If the row is missing or shape is wrong → `Fail`, even if UI passed.

## Chrome memory hygiene (critical)
A prior run ballooned Chrome to >10GB. Keep memory bounded:
- **One case per session.** Don't chain multiple cases in one Claude session — each case in a fresh session with fresh tabs.
- **No full-page reads on Google Calendar.** Never call `read_page` on the GCal tab — it returns a massive a11y tree. Use `find` with a targeted query instead.
- **Screenshot only when needed for verification.** Don't screenshot for progress updates.
- **Close old tabs before opening new ones** — don't accumulate.
- **If Chrome starts lagging mid-case, stop and ask the user** whether to continue or quit & reopen Chrome.

## GCal anchor bug already identified (from A1)
When a routine is created app-side with weekly BYDAY=MO but `createdTs` falls on another day, the GCal master event's DTSTART lands on the creation day. GCal then renders the first occurrence on that off-day in addition to the correct Monday instances. This is a known anomaly — if you see an extra event on today's date for a weekly-Monday series, that's the existing bug, not a new failure.

## Per-case procedure
1. Read the specific case's Given/When/Then from the matrix doc.
2. Set up (create fresh routine if the plan says so). Title format: `e2e-smoke-<case>-<unix-ts>`.
3. Perform the "When" action exactly as described.
4. Wait ≤30s for automatic sync.
5. Verify "Then" assertions via UI only.
6. Record: `Pass / Fail / N-A / Timeout` with a 1-3 line note.
7. Append the result to `e2e/gcal-sync-smoke/session-1-results.md` (create if missing). Entry format:
   ```
   ## <case-id> — <scenario summary>
   **Status:** Pass | Fail | N-A | Timeout
   **Observed:** …
   **Notes:** …
   **Routine title:** e2e-smoke-<case>-<ts> (so cleanup knows what to delete)
   ```

## Known pre-existing state (not created by these tests)
- A routine called `routine 1` exists (every 3 days at 09:00 for 1h, 6 occurrences) with items on scattered dates. Ignore as noise.
- A routine `e2e-smoke-A1-1776757989` exists (weekly Mon 09:00 30m). This is the A1 test artifact — **A2 reuses it**, others create fresh routines.

## Reporting cadence
Each case writes a single block into the session-1 results file. No chat output needed beyond a one-line status.
