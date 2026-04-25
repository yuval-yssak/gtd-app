# Session 2 — E-series only: "This and following" splits

**Scope:** E1–E8 only. Runs in a fresh Claude session. Self-contained.
**Estimated runtime:** ~45–75 min.
**Do NOT read the full matrix doc** (`/Users/yuvalyssak/gtd/docs/CALENDAR_ROUTINE_SYNC_TESTS.md`) — the 9 relevant entries are inlined below. Context discipline is the point of this plan.

---

## Context discipline (read first, internalize)

A prior session burned context on: full-matrix read, find-then-screenshot habit, chat narration, 28-task TODO list. Avoid all four.

**Rules of engagement:**
- **Don't read** `CALENDAR_ROUTINE_SYNC_TESTS.md`, `gcal-sync-smoke-session-2-splits-tz-until-deactivation.md`, or `README.md`. Everything needed is in this file + `gcal-sync-smoke-case-shared-preamble.md`.
- **Read preamble once** at session start.
- **Don't take intermediate screenshots.** `find` returns a ref with a description that tells you whether the click landed. Screenshot only at the two verification moments per case (listed per case below).
- **Never `read_page` on the GCal tab** — memory bloat risk.
- **No TaskCreate.** 9 cases, one plan file, linear execution. Tasks are overkill.
- **Minimal chat narration.** One line per case: `Starting E<n>` → `E<n> Pass/Fail/N-A — <5-word note>`. Nothing else unless blocked.
- **One Write per case** to append to the results file. Never Edit the results file mid-case.

**If context feels tight at any point:** stop after the current case, write a handoff note in the results file (`## Session ended at E<n>. Next session: start with <case-id>.`), and tell the user to start a new session.

---

## Preflight (run once, in order, no screenshots yet)

1. `curl -s -o /dev/null -w "%{http_code}" http://localhost:4173` → expect 200.
2. `curl -s -o /dev/null -w "%{http_code}" http://localhost:4000` → expect 404 (404 on `/` means API is up).
3. Load chrome MCP tools: `ToolSearch({ query: "claude-in-chrome", max_results: 30 })`.
4. `mcp__claude-in-chrome__tabs_context_mcp({ createIfEmpty: true })`.
5. Identify which tab has `localhost:4173` and which has `calendar.google.com/calendar/u/2/`. If either missing, create.
6. **Known gotcha:** one Chrome tab may throw "Cannot access a chrome-extension:// URL of different extension" — if so, create a fresh tab via `tabs_create_mcp` and navigate it to `http://localhost:4173`. Use the fresh tab and ignore the broken one.
7. **One screenshot of each tab** to confirm: app shows GTD sidebar, GCal shows `Yuval GTD Test` calendar on `/u/2/`. Stop and ask user if either is wrong.

**Important:** GTD test user Google Calendar is always `/u/2/`. Target calendar is the primary on `yuval.gtd.test@gmail.com`.

**If preflight fails anywhere, stop and ask the user.** Do not retry blindly.

---

## Execution protocol (per case)

1. Capture timestamp: `date -Iseconds` (record verbatim in result), and `date +%s` for the routine title suffix.
2. Check "Reuse from" — if a prior case left the needed routine state, reuse it. Don't recreate.
3. Perform the exact click/key sequence listed in the case.
4. Wait ≤ 30s for sync. Use `mcp__claude-in-chrome__computer` action `wait` with `duration: 10` (repeat up to 3 times). **Never use bash `sleep`.**
5. Verify via the **2 screenshots listed per case** (app Routines page, GCal week view). Don't add extra screenshots.
6. Record result via one `Write` call appending to `e2e/gcal-sync-smoke/session-2-E-results.md` (format below).
7. One-line chat update: `E<n> Pass — <short note>` or `E<n> Fail — <what failed>` or `E<n> Blocked — <what's unclear>`.

**Blocking rule:** if a UI affordance isn't obvious (especially the split gesture in E1), **stop and ask the user once**. Don't try to infer. The user expects to be pulled in for E1 specifically.

---

## Results file format

File: `e2e/gcal-sync-smoke/session-2-E-results.md`. Create on first case if missing. Per case, append:

```
## E<n> — <short scenario>
**Run at:** <ISO 8601 from `date -Iseconds`>
**Status:** Pass | Fail | N-A | Timeout | Blocked
**Routine title(s):** e2e-smoke-E<n>-<ts> (and any reused titles)
**Observed:** 2–5 sentences. What did the app show? What did GCal show?
**Notes:** anything surprising, anomalies, cross-refs to matrix open questions.
```

---

## The 9 cases (inlined Given/When/Then + verification steps)

### E1 — App-side split via routine RRULE change

**Reuse from:** none (fresh routine).

**Given:** new calendar routine `R` with `RRULE=FREQ=WEEKLY;BYDAY=MO`, 09:00, 60min, linked to GCal.

**When:** edit `R`, change RRULE or time, trigger a "this and following" split.

**Then:**
- App: `R` now capped with UNTIL (date before today); a new routine `R'` exists with the new rule, linked to its own GCal event. Routines list shows both.
- GCal: original recurring event has UNTIL; a new recurring event starting today/tomorrow with the new rule exists.

**Setup steps:**
1. Navigate app tab to `/routines`.
2. `find` "Create routine button" → click.
3. `find` "Title input field in new routine dialog" → `form_input` value = `e2e-smoke-E1-<ts>`.
4. `find` "CALENDAR type toggle button" → click.
5. `find` "Specific days of the week radio button" → click. (Mon is selected by default.)
6. `find` "Save or Create button in new routine dialog footer" → click Create routine.
7. Wait 5s. Screenshot app. Confirm new routine appears.
8. Screenshot GCal. Confirm new event visible on next Monday (Apr 27 2026 area).

**Split gesture — UNKNOWN UI:**
9. Click the newly created routine in the Routines list to open its edit dialog.
10. **Take one screenshot.** Describe the dialog to the user in 1-3 lines: does it show a scope chooser (this / this-and-following / all)? What fields are editable? Pause and ask:
    > The matrix says changing RRULE triggers a "this and following" split. Looking at this dialog, what's the gesture? Do I change the BYDAY (e.g. Mon→Tue)? Is there an explicit scope dropdown? Please walk me through the exact clicks.
11. After the user answers, perform the split action.

**Verify (2 screenshots):**
12. Screenshot app Routines page → expect two routines (original capped + new tail).
13. Screenshot GCal week view → expect original event truncated (UNTIL) and a new event starting after the cap.

**Record:** title(s), dates observed. Flag if the master event's UNTIL-propagation didn't happen in 30s.

---

### E2 — GCal-side split with time shift

**Reuse from:** none. Need a fresh routine so the pre-split item count is deterministic (a known regression was masked when E2 only checked routine-level state).

**Given:** new routine `R` (weekly-Mon, 09:00, 30min) linked to GCal with future items generated.

**When:** in GCal, open one occurrence of the master, click the event, choose "Edit event" → scope dialog → "This and following events" → change time (e.g. 09:00 → 10:30) → Save.

**Then:**
- GCal: original master now has UNTIL; new master event for the tail with the new time.
- App: after sync (≤30s), `R.rrule` has UNTIL; new routine `R'` exists with `splitFromRoutineId = R._id` and the new time.
- **App Calendar: the tail's future dates show items at the new time (10:30), not 09:00 and not missing.** This is the regression lane — a tail routine that arrives with zero items means the user has lost their schedule for all post-split dates.

**Setup steps:**
1. Create a fresh routine titled `e2e-smoke-E2-<ts>` (E1 steps 1–6). Wait 10s for GCal event creation.
2. Navigate GCal tab to `https://calendar.google.com/calendar/u/2/r/week/2026/4/26`.
3. Take one screenshot. Locate the `e2e-smoke-E2-<ts>` event on Mon Apr 27.
4. **Do not use `read_page` on GCal.** Use `find` with query "e2e-smoke-E2 event tile on Monday Apr 27" → click to open the event popover.
5. `find` "Edit event (pencil icon)" → click.
6. Change the start time to 10:30 via `form_input` on the time field (find "Start time input" in the editor).
7. `find` "Save button in GCal event editor" → click.
8. GCal will show a scope dialog: `find` "This and following events option" → click. `find` "OK or Save in scope dialog" → click.

**Verify (3 screenshots after waiting 30s, plus one mongosh query):**
9. Screenshot GCal week → expect old event series (before today) and a new series (after today) at 10:30.
10. Screenshot app `/routines` → expect two routines: one with the old rule capped, one with new rule (10:30).
11. Screenshot app `/calendar` for the week covering the split boundary → expect the post-split Mondays to show `e2e-smoke-E2-*` items at **10:30**. If any post-split Monday is blank, the regression is back.
12. mongosh one-shot (shape per preamble) — count items linked to the tail routine:
    ```
    db.items.countDocuments({ routineId: <tail._id>, status: 'calendar', timeStart: { $gte: <today-ISO> } })
    ```
    Expect `>= 3`. If `0`, the tail arrived without items → fail with "tail routine has zero items after split with time shift" (cross-ref: server-side `createRoutineFromGCal` regression).

**Record:** two explicit lines in the result block: `tail-routine-found: yes|no`, `tail-items-count: <N>`. This makes the regression machine-checkable in future runs.

---

### E3 — App-side split, then GCal-side edit on the tail

**Reuse from:** E1 chain (`R` capped + `R'` tail). **Do not create fresh routines.**

**Given:** split chain `R` → `R'` from E1. `R'` has a master event in GCal.

**When:** in GCal, open `R'`'s master event → Edit → change a non-structural field (e.g. title or description) → Save, apply to all events of `R'`.

**Then:**
- GCal: `R'` master updated.
- App: after sync, `R'.title` or `R'.template.notes` reflects the change. `R` untouched.

**Setup steps:**
1. Navigate GCal tab to the week where `R'`'s event is visible (likely the current week or next).
2. `find` "R' master event (title matches tail)" → click → Edit.
3. Change title to `e2e-smoke-E3-edited-<ts>`.
4. Save → "All events".

**Verify (2 screenshots after 30s wait):**
5. Screenshot app `/routines` → expect `R'` title updated.
6. Screenshot GCal week → `R'` event shows new title.

**Record:** confirm `R` (the capped original) title is unchanged.

---

### E4 — GCal-side split, then app-side edit on the tail

**Reuse from:** E2 chain (`R` → `R'` via GCal-originated split).

**Given:** split chain from E2.

**When:** in the app, open `R'`'s routine edit dialog → change title to `e2e-smoke-E4-edited-<ts>` → Save.

**Then:**
- App: `R'.title` updated.
- GCal: after outbound push (≤30s), `R'` master event title reflects.

**Setup steps:**
1. Navigate app to `/routines`.
2. Click `R'` (the tail from E2) to open edit.
3. Change title field, Save.

**Verify (2 screenshots after 30s):**
4. Screenshot app `/routines` → title updated.
5. Screenshot GCal → tail master event title updated.

**Record:** confirm `R` (original) untouched.

---

### E5 — Repeated splits (split a tail again)

**Reuse from:** E1 chain (`R` → `R'`). We split `R'` again to produce `R''`.

**Given:** split chain from E1.

**When:** in the app, open `R'`'s edit dialog → trigger another "this and following" split at a later date (exactly as E1 did — same gesture).

**Then:** 3-routine chain: `R` → `R'` → `R''`. Each segment has its own GCal master.

**Setup steps:** Use the split gesture the user described at E1. Title the tail naturally (app-generated).

**Verify (2 screenshots after 30s):**
1. App `/routines` → 3 routines in the chain.
2. GCal → 3 recurring series, each in its own date range.

**Record:** note any chain-reference UI (does the app label `R''` as derived from `R'`?). This informs matrix open-question #5.

---

### E6 — App-side split with existing instance override on the original

**Reuse from:** none (needs fresh routine with a pre-split override).

**Given:** new routine `R` (same shape as E1). Before splitting, modify a single future instance's time (A2-style: click an upcoming item → change `timeStart`). That creates a `routineException`. Then split `R` at a later date.

**When:** split at a date after the overridden instance (so the override is on the pre-split segment).

**Then:**
- `R` (capped) still has the exception on the overridden date.
- `R'` (tail) has no exceptions.

**Setup steps:**
1. Create fresh routine title `e2e-smoke-E6-<ts>` (E1 steps 1–6).
2. Navigate app to `/calendar`. Find a near-future instance of `e2e-smoke-E6-*`.
3. Click it → edit `timeStart` to a different time (e.g. 09:00 → 11:00) → save.
4. Wait 5s. Back to `/routines`. Open the routine edit dialog. Perform split (same gesture as E1) at a date later than the overridden instance.

**Verify (2 screenshots + 1 mongosh):**
5. Screenshot app `/calendar` → overridden instance still shows modified time on `R` segment.
6. Screenshot app `/routines` → 2 routines.
7. mongosh (one-shot, from preamble): check `R.routineExceptions` still contains the override row.

**Record:** confirm tail `R'` has empty `routineExceptions`.

---

### E7 — GCal-side split where tail has different RRULE

**Reuse from:** none (needs a fresh routine so we can do a clean GCal-side split with RRULE change).

**Given:** new routine `R` (`BYDAY=MO`, same as E1) synced to GCal.

**When:** in GCal, open master event → "This and following" scope → change recurrence from weekly-Mon to weekly-Tue+Thu → Save.

**Then:** like E2 but `R'.rrule` reflects the new pattern. Tail items generate on Tue/Thu.

**Setup steps:**
1. Create fresh routine title `e2e-smoke-E7-<ts>`.
2. In GCal, open master → Edit → change "Does not repeat"/recurrence field to "Weekly on Tuesday, Thursday" → Save → This and following.

**Verify (2 screenshots after 30s):**
3. Screenshot GCal → original on Mon (capped), new series on Tue/Thu.
4. Screenshot app `/routines` → 2 routines, tail with Tue/Thu pattern.

---

### E8 — Detection ambiguity (false-positive risk)

**Reuse from:** any capped routine from E1/E2/E6/E7 (pick one where UNTIL is set). If none, create and cap one first (do E1's setup + split).

**Given:** routine `R` with `UNTIL=<some-date>` from a prior split.

**When:** in GCal, create a *new, unrelated* recurring event `E_unrelated` starting 0–2 days after `R.UNTIL`, same calendar, different title (e.g. `unrelated-E8-<ts>`). Different RRULE.

**Then:**
- Ideally the app treats `E_unrelated` as a *new* routine (no split link).
- **Known risk (matrix open question #5):** the heuristic may incorrectly link it as `R`'s tail.

**Setup steps:**
1. Identify a capped routine `R` from a prior case. Note its UNTIL date.
2. In GCal, click a day 1–2 days after UNTIL → Create event → recurring weekly, totally different title and time (e.g. `unrelated-E8-<ts>`, Wed 14:00). Save.

**Verify (2 screenshots after 30s):**
3. Screenshot app `/routines` → expect a new standalone routine `unrelated-E8-*`, NOT a tail of `R`.
4. Check (via one mongosh query from the preamble template — shape per preamble): does the new routine have `splitFromRoutineId` pointing at `R`? If yes → **Fail, false-positive confirmed**. If no → Pass.

**Record:** explicit yes/no on whether the heuristic false-positived. Cross-reference matrix open question #5.

---

## Closing (after E8)

Write a final block to the results file:

```
## Session 2 E-series summary
**Completed at:** <ISO 8601>
**Passed:** <n> / 9
**Failed:** list of case IDs + 1-line cause each
**Blocked:** list of case IDs
**Key findings (3–5 bullets):**
- …
```

One final chat message: `E-series done. Passed X/9. See session-2-E-results.md for details.` Nothing else.

## Cleanup
**Do not delete any routines or events.** User handles cleanup after reviewing results.
