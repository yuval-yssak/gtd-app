# Session 2 — E-series with seeded past data

**Scope:** E1–E8. Fresh Claude session. Self-contained.
**Estimated runtime:** ~60–90 min (seeding adds overhead vs. the original plan).
**Do NOT read the full matrix doc** (`docs/CALENDAR_ROUTINE_SYNC_TESTS.md`) — the 8 relevant cases are inlined below.

---

## Why this exists

A previous run of `gcal-sync-smoke-session-2-E-series.md` failed at E1 with a key finding:

> The app-side split heuristic (`routineHasPastItems` in `client/src/lib/routineSplitUtils.ts`) only
> triggers a split when the routine has at least one IDB `calendar`-status item with `timeStart <
> today`. A freshly created routine has no past items, so editing it is treated as an in-place
> edit, not a split. Without a split, E3/E5 (which reuse E1's chain) and E6 (same constraint) are
> blocked.

The user chose option **(b)** — seed past data in **GCal + MongoDB + IndexedDB** so that every
cases' "Given" precondition (a routine with past items + GCal events) is real. This plan bakes
that seeding in.

---

## Context discipline

Avoid all four of the prior session's pitfalls:
- **Don't read** `CALENDAR_ROUTINE_SYNC_TESTS.md`, the original `gcal-sync-smoke-session-2-E-series.md`, or `README.md`. Everything you need is in this file + `gcal-sync-smoke-case-shared-preamble.md` + `project_routine_split_gesture.md` memory.
- **Read preamble once** at session start.
- **Don't take intermediate screenshots.** Screenshot only at the two verification moments per case.
- **Never `read_page` on the GCal tab** — memory bloat risk.
- **No TaskCreate.** 9 cases, one plan file, linear execution.
- **Minimal chat narration.** One line per case: `Starting E<n>` → `E<n> Pass/Fail/N-A — <5-word note>`.
- **One Write per case** appending to results file.

**Context-tight stop rule:** after any case, if context feels tight, write a handoff note
(`## Session ended at E<n>. Next session: start with <case-id>.`) and ask the user to start a new
session.

---

## Preflight (run once, no screenshots until step 8)

1. `curl -s -o /dev/null -w "%{http_code}" http://localhost:4173` → expect 200.
2. `curl -s -o /dev/null -w "%{http_code}" http://localhost:4000` → expect 404.
3. Load Chrome MCP tools: `ToolSearch({ query: "claude-in-chrome", max_results: 30 })`.
4. `mcp__claude-in-chrome__tabs_context_mcp({ createIfEmpty: true })`.
5. Identify the app tab (`localhost:4173`) and GCal tab (`calendar.google.com/calendar/u/2/`). Create if missing.
6. Known gotcha: one Chrome tab may throw "Cannot access a chrome-extension:// URL of different extension" — create a fresh tab and use it.
7. **Sanity-check DB reseed risk.** Run:
   ```bash
   mongosh "mongodb://127.0.0.1:27017/gtd_dev" --quiet --eval '
     const acc = db.account.findOne({providerId:"google"});
     const r = db.routines.countDocuments({user: acc?.userId});
     print("user:", acc?.userId, "routines:", r);
   '
   ```
   If `routines: 0` and you expect state from a prior session → a seed script wiped the DB. Just proceed; this plan creates all state from scratch.
8. Screenshot each tab. Confirm: app shows GTD sidebar; GCal shows `Yuval GTD Test` calendar on `/u/2/`. Stop if either is wrong.

If preflight fails anywhere, stop and ask the user. Do not retry blindly.

---

## Seeding procedure (shared helper — used by E1, E2, E6, E7)

Purpose: give a fresh routine a realistic history so `routineHasPastItems` returns true and the
split heuristic fires.

**Target shape:**
- Routine: calendar-type, `FREQ=WEEKLY;BYDAY=MO`, 09:00 for 60m, linked to GCal.
- Past items: 3 past-Monday `calendar`-status items in IDB, each with `routineId = R._id`, `timeStart`/`timeEnd` set to 09:00–10:00 local, `calendarEventId` set (so delete cascades match).
- Past GCal events: 3 single-occurrence events on the same past Mondays, same calendar, titles
  matching `R.title` (cosmetic realism — not strictly required by the split heuristic, but part
  of what the user asked for).
- MongoDB: the 3 items must be mirrored to the server so cross-device invariants hold.

### Seeding steps (run per routine that needs history)

1. **Create routine via UI** (see each case's setup steps). Wait 10s for GCal sync.
2. **Capture the routine's identifiers** in a JS snippet run against the app tab:
   ```js
   (async () => {
     const rs = await window.__gtd.listRoutines();
     const r = rs.find(x => x.title.startsWith('e2e-smoke-<case>-'));
     return JSON.stringify({_id:r._id, userId:r.userId, integrationId:r.calendarIntegrationId, configId:r.calendarSyncConfigId, createdTs:r.createdTs});
   })()
   ```
3. **Create 3 past GCal events (via GCal UI)** — non-recurring singles, same title as routine, on
   Mondays ~1, 2, 3 weeks ago at 09:00 for 60m. *(Backdating a recurring series isn't possible in
   GCal UI; singles are the workaround for realism.)*

   Click each past Monday in GCal week/month view → type title → 9:00am – 10:00am → Save. Three
   times total. **Do NOT take screenshots between each.** One final screenshot after all 3 are
   created confirms them.
4. **After the 3 singles are created, fetch their event IDs** from the server via a direct Mongo
   read (so IDs bind to items locally):
   ```bash
   mongosh "mongodb://127.0.0.1:27017/gtd_dev" --quiet --eval '
     const uid = "<userId from step 2>";
     const r = db.items.find({user: uid, title: "<routine title>"}).sort({timeStart:1}).toArray();
     print(JSON.stringify(r.map(x => ({_id:x._id, timeStart:x.timeStart, calendarEventId:x.calendarEventId})), null, 2));
   '
   ```
   If the GCal→app sync already imported them, you'll see 3 rows. If empty, wait 30s and re-run
   (GCal push-to-app sync takes a moment). If still empty, the integration may be asleep — in the
   app open the routine edit dialog briefly and close to trigger a sync; recheck.
5. **Attach them to the routine in IDB.** The items imported in step 4 came in as standalone
   `calendar` items (no `routineId`). Rewrite them in IDB to attach to the routine:
   ```js
   (async () => {
     const routineId = '<R._id from step 2>';
     const db = window.__gtd.db;
     const all = await db.getAllFromIndex('items', 'userId', '<userId>');
     const pastMondays = all.filter(i => i.status === 'calendar' && i.title === '<routine title>' && i.timeStart < new Date().toISOString().slice(0,10));
     const now = new Date().toISOString();
     for (const item of pastMondays) {
       const updated = { ...item, routineId, updatedTs: now };
       await db.put('items', updated);
       await db.add('syncOperations', { entityType: 'item', entityId: item._id, opType: 'update', queuedAt: now, snapshot: updated });
     }
     await window.__gtd.flush();
     return pastMondays.length;
   })()
   ```
6. **Verify seeding worked** via JS:
   ```js
   (async () => {
     const { routineHasPastItems } = await import('/src/lib/routineSplitUtils.ts');
     const db = window.__gtd.db;
     return routineHasPastItems(db, '<userId>', '<R._id>');
   })()
   ```
   Expected: `true`. If `false`, check:
   - Items have `routineId` set correctly (step 5).
   - Items have `status === 'calendar'` (not `'done'` — past items auto-transition after their
     date in some views? check MyDB.ts — no, status is static until user acts).
   - `timeStart < todayStr` where `todayStr = YYYY-MM-DD`.

**Seeding fallback (faster, less realistic):** if GCal event creation is slow or flaky, skip
steps 3–4 and synthesize items directly in IDB + Mongo:

```js
(async () => {
  const routineId = '<R._id>', userId = '<userId>';
  const db = window.__gtd.db;
  const pastDates = [/*3 past Mondays as YYYY-MM-DD*/];
  const now = new Date().toISOString();
  for (const d of pastDates) {
    const item = { _id: crypto.randomUUID(), userId, status: 'calendar', title: '<routine title>', routineId, timeStart: `${d}T09:00:00`, timeEnd: `${d}T10:00:00`, createdTs: now, updatedTs: now };
    await db.put('items', item);
    await db.add('syncOperations', { entityType:'item', entityId:item._id, opType:'create', queuedAt:now, snapshot:item });
  }
  await window.__gtd.flush();
})()
```

This skips GCal event realism but is enough to trigger the split heuristic. **Use the fallback
only if the user says so at the start of the session** — by default, do the full seed.

---

## Execution protocol (per case)

1. Capture timestamp: `date -Iseconds` (record verbatim) and `date +%s` for the title suffix.
2. Check "Reuse from" — if a prior case in this session left the needed state, reuse it.
3. Seed past data if the case's precondition calls for it (via the procedure above).
4. Perform the click/key sequence listed in the case.
5. Wait ≤30s for sync. Use `computer.wait` with `duration: 10` up to 3×. Never `sleep`.
6. Verify via the 2 screenshots listed per case.
7. Record via one `Write` appending to `e2e/gcal-sync-smoke/session-2-E-results.md`.
8. One-line chat update.

**Blocking rule:** if a UI affordance is unclear (especially a split gesture), stop and ask the
user once. The user expects involvement if anything's off.

---

## Results file format

File: `e2e/gcal-sync-smoke/session-2-E-results.md`. Create on first case if missing. Per case,
append:

```
## E<n> — <short scenario>
**Run at:** <ISO 8601 from `date -Iseconds`>
**Status:** Pass | Fail | N-A | Timeout | Blocked
**Routine title(s):** e2e-smoke-E<n>-<ts> (and any reused titles)
**Seeded:** yes/no (count of past items, count of past GCal events)
**Observed:** 2–5 sentences. App state + GCal state.
**Notes:** anomalies, cross-refs to matrix open questions.
```

---

## Baseline expectations after a successful split (E1-style)

After a successful app-side split, verify:

- `/routines` shows **two rows** with the same title (original capped + new tail). If the app
  renders split pairs differently (e.g. only the tail, with the original hidden), note that as a
  UX observation but don't mark it a failure.
- Via `__gtd.listRoutines()`:
  - Original routine: `rrule` contains `UNTIL=<yesterday>T235959Z`, `active: false`.
  - Tail routine: new `_id`, `splitFromRoutineId === <original._id>`, `active: true`, same title
    (unless the user's edit changed it), `createdTs` = split date at 00:00Z.
- Via GCal: original master has UNTIL (no future occurrences); a new master exists from today/
  tomorrow onward with the new rule.
- Per memory `project_routine_split_gesture.md`: "The capped past routine should end up Paused (not Active)." If the capped routine shows Active in the UI, that's a regression — note but don't block.

---

## The 8 cases (inlined)

### E1 — App-side split via routine RRULE change

**Reuse from:** none. Fresh routine, seeded with past items.

**Given:** routine `R` created via the UI (calendar, `FREQ=WEEKLY;BYDAY=MO`, 09:00, 60m, linked
to GCal) with **3 seeded past-Monday items + 3 seeded past GCal events**.

**When:** open `R`'s edit dialog (click the per-row Edit button — clicking the row alone does
nothing), change BYDAY Mon→Tue, Save.

**Then:**
- App `/routines`: 2 rows — `R` capped (UNTIL=yesterday), `R'` tail (BYDAY=TU).
- GCal: original Monday series capped; new Tuesday series from today/tomorrow onward.

**Setup:**
1. App tab → `/routines`.
2. `find` "Create routine button" → click.
3. `find` "Title input in new routine dialog" → `form_input` value = `e2e-smoke-E1-<ts>`.
4. `find` "CALENDAR type toggle" → click.
5. `find` "Specific days of the week radio" → click (Mon default).
6. `find` "Save or Create button in new routine dialog" → click.
7. `wait 10`. Confirm no errors in the app console (`read_console_messages` with `onlyErrors:
   true`, pattern matching `routine|sync`).
8. **Seed past data** (follow the seeding procedure above — 3 past Mondays).

**Trigger the split:**
9. `find` "Edit button on e2e-smoke-E1 row" → click.
10. `find` "Monday day-of-week toggle" → click (deselects Mon).
11. `find` "Tuesday day-of-week toggle" → click (selects Tue).
12. `find` "Save button in edit dialog" → click.
13. `wait 10` twice (20s total).

**Verify (2 screenshots):**
14. Screenshot app `/routines` → expect 2 routines.
15. Screenshot GCal week of this Monday → expect original Monday event truncated; new Tuesday event.

**Record:** title, ISO timestamp, seeded counts, split chain verification (via `__gtd.listRoutines()` 
to dump `{_id, title, rrule, active, splitFromRoutineId}` for both routines).

---

### E2 — GCal-side split

**Reuse from:** E1's tail `R'` if it exists and is Active. Otherwise create a fresh seeded routine
(same setup as E1 steps 1–8, title `e2e-smoke-E2-<ts>`).

**Given:** routine linked to GCal with a future master event.

**When:** in GCal: open one occurrence → "Edit event" (pencil) → change start time 09:00 → 10:30
→ Save → scope dialog → "This and following events" → OK.

**Then:**
- GCal: original master has UNTIL; new master from split date at 10:30.
- App `/routines` (after ≤30s): `R.rrule` has UNTIL, new routine `R'` with `splitFromRoutineId =
  R._id`, new time 10:30.

**Setup:**
1. Decide `R`: reuse E1's tail or create fresh + seed per procedure above.
2. GCal tab → `https://calendar.google.com/calendar/u/2/r/week/2026/4/26` (or the week where R's
   next occurrence lives).
3. **No screenshot yet.** Use `find` "<routine title> event tile on <day>" → click to open popover.
4. `find` "Edit event pencil icon" → click.
5. `find` "Start time input" → `form_input` value = `10:30am`. (If the input is a combobox, type
   and hit Enter via `computer.key "Enter"`.)
6. `find` "Save button in GCal editor" → click.
7. Scope dialog: `find` "This and following events radio" → click. `find` "OK button in scope
   dialog" → click.
8. `wait 10` × 3 (30s).

**Verify (2 screenshots):**
9. Screenshot GCal week → old Monday series capped, new Monday series at 10:30.
10. Screenshot app `/routines` → 2 routines with matching times.

**Record:** did the app detect the split? `__gtd.listRoutines()` dump → look for
`splitFromRoutineId` on the new tail. If only one routine exists and was mutated in place, note
whether this matches matrix open-question #5 (detection heuristic).

---

### E3 — App-side split, then GCal-side edit on the tail

**Reuse from:** E1 chain (`R` + `R'`). If E1 failed, create fresh per E1 setup including seeding.

**Given:** E1's `R → R'` chain. `R'` has a master event in GCal.

**When:** in GCal open `R'`'s master event → Edit → change title to `e2e-smoke-E3-edited-<ts>` →
Save → "All events".

**Then:**
- GCal: `R'` master title updated.
- App: after ≤30s, `R'.title` reflects the change. `R` (capped) untouched.

**Setup:**
1. GCal tab → week where `R'`'s next event is visible.
2. `find` "<R' title> event tile" → click → Edit (pencil).
3. `find` "Title input in GCal editor" → `form_input` value = `e2e-smoke-E3-edited-<ts>`.
4. `find` "Save" → click. Choose "All events" in the scope dialog.
5. `wait 10` × 3.

**Verify (2 screenshots):**
6. Screenshot app `/routines` → `R'` title is `e2e-smoke-E3-edited-<ts>`; `R` title unchanged.
7. Screenshot GCal week → `R'` tile shows new title.

**Record:** confirm `R` title unchanged via `__gtd.listRoutines()`.

---

### E4 — GCal-side split, then app-side edit on the tail

**Reuse from:** E2 chain (`R → R'` from GCal-side split).

**Given:** E2's chain.

**When:** in the app, open `R'` edit dialog → change title to `e2e-smoke-E4-edited-<ts>` → Save.

**Then:**
- App: `R'.title` updated.
- GCal: after ≤30s, `R'` master event title reflects.

**Setup:**
1. App tab → `/routines`.
2. `find` "Edit button on <R' title> row" → click.
3. `find` "Title input in edit dialog" → `form_input` value = `e2e-smoke-E4-edited-<ts>`.
4. `find` "Save button" → click.
5. `wait 10` × 3.

**Verify (2 screenshots):**
6. Screenshot app `/routines` → `R'` title updated; `R` unchanged.
7. Screenshot GCal week → `R'` master event title updated.

**Record:** confirm `R` title unchanged.

**Important:** the app-side edit to `R'` may itself trigger another split if `R'` now has past
items (from E2's split date). If you see a 3-routine chain after E4, that's a finding — note it;
don't mark as failure (matrix is ambiguous).

---

### E5 — Repeated splits (split the tail again)

**Reuse from:** E1 chain. We split `R'` again to produce `R''`.

**Given:** E1 chain + some past items accumulated on `R'` (whose `createdTs` was E1's split date).
`R'` may not have past items yet if E1 ran today — see "past-items gotcha" below.

**Past-items gotcha for E5:** `R'` was created at the split date (today, in E1). So by E5, `R'`
has **zero past items**, and editing it will be an in-place edit, not a split. To make E5
meaningful, **re-seed `R'`** with 1–2 past items by repeating the seeding procedure for `R'`:
- Past GCal events with `R'.title` on the past Mondays from E1's seed window (they already exist
  — just re-attach to `R'` via IDB).
- Or: use the fast-fallback seed (steps in seeding procedure) to synthesize items directly.

**When:** open `R'` edit dialog → change BYDAY Tue → Wed → Save.

**Then:** 3-routine chain: `R → R' → R''`. Each has its own GCal master.

**Setup:**
1. Re-seed `R'` with 2 past items (fast fallback is fine here — realism already established in E1).
2. `find` "Edit button on <R' title> row" → click.
3. `find` "Tuesday toggle" → click (deselect). `find` "Wednesday toggle" → click (select).
4. `find` "Save" → click.
5. `wait 10` × 3.

**Verify (2 screenshots):**
6. Screenshot app `/routines` → 3 routines in the chain (2 capped + 1 tail).
7. Screenshot GCal → 3 series, each in its own date range.

**Record:** dump all 3 routines via `__gtd.listRoutines()` with `{_id, title, rrule, active,
splitFromRoutineId}`. Note the chain-reference: does the UI label `R''` as derived from `R'`?
Informs matrix open-question #5.

---

### E6 — App-side split with existing instance override on the original

**Reuse from:** none. Fresh routine with a pre-split override.

**Given:** new routine `R` (same shape as E1, seeded with 3 past Mondays). Before splitting,
modify a single near-future instance's `timeStart` (A2-style). Creates a `routineException` of
type `modified`. Then split `R` at a later date.

**When:** split after the overridden instance.

**Then:**
- `R` (capped) still has the exception row on the overridden date.
- `R'` (tail) has no exceptions.

**Setup:**
1. Create + seed routine `e2e-smoke-E6-<ts>` (E1 setup + seeding).
2. App → `/calendar`. `find` "<routine title> event on <next Monday>" → click.
3. In the edit dialog, change `timeStart` from 09:00 → 11:00. Save.
4. `wait 10`. Confirm routineException was written:
   ```bash
   mongosh "mongodb://127.0.0.1:27017/gtd_dev" --quiet --eval '
     JSON.stringify(db.routines.findOne({_id:"<R._id>"}, {title:1, routineExceptions:1}), null, 2)
   '
   ```
   Expected: one entry, `type:"modified"`, `newTimeStart`/`newTimeEnd` = 11:00/12:00.
5. App → `/routines`. Edit dialog for `R`. Change BYDAY Mon → Tue. Save.
6. `wait 10` × 3.

**Verify (2 screenshots + 1 mongosh):**
7. Screenshot app `/calendar` → overridden instance at 11:00 still shown on `R` segment.
8. Screenshot app `/routines` → 2 routines.
9. mongosh: verify `R.routineExceptions` still contains the override; verify `R'.routineExceptions`
   is empty/absent:
   ```bash
   mongosh "mongodb://127.0.0.1:27017/gtd_dev" --quiet --eval '
     const rs = db.routines.find({title:{$regex:"e2e-smoke-E6"}}, {title:1, rrule:1, routineExceptions:1, splitFromRoutineId:1, active:1}).toArray();
     JSON.stringify(rs, null, 2)
   '
   ```

**Record:** verbatim `routineExceptions` for both routines. Confirm tail is empty.

---

### E7 — GCal-side split where tail has different RRULE

**Reuse from:** none. Fresh seeded routine.

**Given:** new routine `R` (`BYDAY=MO`, seeded) synced to GCal.

**When:** in GCal, open master → Edit → change recurrence from "Weekly on Monday" to "Weekly on
Tuesday and Thursday" → Save → "This and following events".

**Then:** like E2 but `R'.rrule` has `BYDAY=TU,TH`. Tail items generate on Tue/Thu.

**Setup:**
1. Create + seed routine `e2e-smoke-E7-<ts>` (E1 setup + seeding).
2. GCal → this week's Monday event. Click → Edit.
3. `find` "Recurrence field" (usually labeled "Weekly on Monday" dropdown) → click.
4. `find` "Custom recurrence option" → click. Select "Tuesday" and "Thursday" checkboxes.
5. Done. Back in editor → Save → "This and following".
6. `wait 10` × 3.

**Verify (2 screenshots):**
7. Screenshot GCal → original Monday series capped; new series on Tue/Thu.
8. Screenshot app `/routines` → 2 routines, tail with BYDAY=TU,TH.

**Record:** `__gtd.listRoutines()` dump with `rrule` for both.

---

### E8 — Detection ambiguity (false-positive risk)

**Reuse from:** any capped routine from E1/E2/E6/E7. Pick one whose UNTIL date is recent.

**Given:** `R` with `UNTIL=<date>`.

**When:** in GCal, create a **new, unrelated** recurring event on a day 1–2 days after `R.UNTIL`,
same calendar, different title and RRULE (e.g. `unrelated-E8-<ts>`, Wed 14:00 weekly).

**Then:**
- Ideally the app treats `E_unrelated` as a **new** routine (no split link).
- Known risk (matrix open question #5): heuristic may incorrectly set
  `splitFromRoutineId` pointing at `R`.

**Setup:**
1. Pick `R` from prior case; note its UNTIL date.
2. GCal → pick a Wednesday 1–2 days after UNTIL. Click that date → Create event.
3. Title = `unrelated-E8-<ts>`. Time 14:00–15:00. Recurrence = Weekly. Save.
4. `wait 10` × 3.

**Verify (2 screenshots + mongosh):**
5. Screenshot app `/routines` → new standalone `unrelated-E8-*` routine exists, NOT nested under `R`.
6. Screenshot GCal week → new event visible.
7. mongosh:
   ```bash
   mongosh "mongodb://127.0.0.1:27017/gtd_dev" --quiet --eval '
     const r = db.routines.findOne({title:{$regex:"unrelated-E8"}}, {title:1, rrule:1, splitFromRoutineId:1});
     JSON.stringify(r, null, 2)
   '
   ```
   - If `splitFromRoutineId` is present → **Fail**, false-positive confirmed.
   - If absent → **Pass**.

**Record:** explicit yes/no on false-positive. Cross-ref matrix open question #5.

---

## Closing (after E8)

Append a final block:

```
## Session 2 E-series summary
**Completed at:** <ISO 8601>
**Passed:** <n> / 8
**Failed:** <case IDs + 1-line cause each>
**Blocked:** <case IDs>
**Seeded:** summary of how many routines needed seeding + how many past items seeded total.
**Key findings (3–5 bullets):**
- …
```

One final chat message: `E-series done. Passed X/8. See session-2-E-results.md for details.`

---

## Cleanup

**Do not delete any routines or events.** User handles cleanup after reviewing.

---

## Reference: known dev-harness surface

From `client/src/db/devTools.ts`, on `window.__gtd`:
- `listRoutines()`, `listItems()`, `listCalendar()`
- `db` — raw `IDBPDatabase<MyDB>` (use `db.getAllFromIndex('items','userId',uid)`, `db.put('items', item)`, `db.add('syncOperations', op)`).
- `flush()` — push queue to server; waits for any pending flush.
- `pull()` — force-pull from server.
- `syncState()`, `queuedOps()` — introspection.

**Key client files if something looks weird:**
- `client/src/lib/routineSplitUtils.ts` — `routineHasPastItems`, `computeSplitDate`, `addUntilToRrule`.
- `client/src/db/routineSplit.ts` — `splitRoutine` (what happens when the split fires).
- `client/src/components/routineEditor/RoutineEditorBody.tsx` — `onSave` orchestrates edit → split-or-in-place.
- `client/src/db/routineItemHelpers.ts` — `generateCalendarItemsToHorizon`, `deleteFutureItemsFromDate`.
- `api-server/src/routes/calendar.ts` — line 780+ `detectAndLinkSplits` (GCal-originated split detection).

**Key server-side fact for E8:** GCal-originated split detection uses a timing overlap heuristic
(`gapDays` between parent's UNTIL and tail's first occurrence). See `detectAndLinkSplits` in
`api-server/src/routes/calendar.ts`.
