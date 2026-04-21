# Calendar Routine ↔ Google Calendar Sync — Test Matrix

This document enumerates the test scenarios for syncing **calendar-type routines** (i.e. routines with `routineType === 'calendar'` and a `calendarItemTemplate`) with Google Calendar recurring events.

`nextAction` routines are out of scope — they have no GCal counterpart.

Each scenario is a numbered Given/When/Then case. Each case lists a likely **test location** to anchor implementation. Cases are grouped by axis:

- **A. App-originated routine, then app-side change**
- **B. App-originated routine, then GCal-side change**
- **C. GCal-originated routine, then app-side change**
- **D. GCal-originated routine, then GCal-side change**
- **E. "This and following" splits (both sides)**
- **F. Concurrent edits / conflict resolution**
- **G. Timezone changes**
- **H. UNTIL boundary / series end**
- **I. Routine deactivation (GCal master deleted)**
- **J. Webhook / sync token expiry / disconnected integration**

Conventions:
- "App side" = local IndexedDB write that flows out via `flushSyncQueue` → server → GCal.
- "GCal side" = a change made directly in Google Calendar UI/API, picked up by `syncSingleCalendar`.
- "Echo window" = the 5-second window in which `lastPushedToGCalTs` suppresses re-import of an own write.
- "Horizon" = the ~2-month window of pre-generated `calendar` items (`generateCalendarItemsToHorizon`).
- "Tail" = the new routine produced by a "this and following" split.
- All ISO dates assume the user's calendar `timeZone` unless stated.

---

## A. App-originated routine, then app-side change

### A1. Create routine in app, link to GCal
**Given** an authenticated user with a connected Google Calendar integration and no existing routines
**When** the user creates a calendar routine `R` (RRULE `FREQ=WEEKLY;BYDAY=MO`, time 09:00, duration 30) and links it to the default calendar
**Then**
- `R.calendarEventId`, `R.calendarIntegrationId`, `R.calendarSyncConfigId` are populated
- A recurring event is created in GCal with matching RRULE, DTSTART derived from `R.createdTs`, and timezone matching the calendar's `timeZone`
- Items are generated locally up to the 2-month horizon
- `R.lastPushedToGCalTs` is stamped within the last 5 seconds
- The next inbound sync does **not** re-import the routine (echo suppressed)

**Test location:** `api-server/src/tests/calendar.test.ts` (link route + outbound push)

---

### A2. Modify a single instance in the app (time change)
**Given** routine `R` from A1 with item `I` for 2026-05-04 09:00
**When** the user edits `I.timeStart` to 11:00 locally and the change is flushed
**Then**
- `I` is updated locally and pushed to GCal as a single-instance override on the recurring series (`recurringEventId === R.calendarEventId`)
- `R.routineExceptions` gains `{ date: '2026-05-04', type: 'modified', itemId: I._id, newTimeStart: '...11:00...', newTimeEnd: '...11:30...' }`
- The next inbound sync does not duplicate or revert `I` (echo suppressed by `lastPushedToGCalTs` on the override push)
- The master event RRULE is unchanged
- Other items in `R` are unaffected

**Test location:** `api-server/src/tests/calendar.test.ts` (item push for series instance) + `client/src/tests/routineItemHelpers.test.ts`

---

### A3. Modify a single instance in the app (title/notes change)
**Given** routine `R` from A1 with item `I` for 2026-05-04
**When** the user edits `I.title` and `I.notes` locally
**Then**
- `I` is pushed to GCal as a single-instance override with new title/description (markdown → HTML)
- `R.routineExceptions` records `type: 'modified'` with `title` and `notes` fields populated
- Master event title/description is unchanged
- Other items unchanged

**Test location:** `api-server/src/tests/calendar.test.ts`

---

### A4. Trash a single instance in the app
**Given** routine `R` from A1 with item `I` for 2026-05-04
**When** the user trashes `I` locally
**Then**
- `I.status` becomes `trash` locally
- A delete-instance override is pushed to GCal (the master event remains, that occurrence is cancelled)
- `R.routineExceptions` gains `{ date: '2026-05-04', type: 'skipped' }`
- Next call to `generateCalendarItemsToHorizon(R)` does **not** recreate an item for that date

**Test location:** `client/src/tests/routineItemHelpers.test.ts` + `api-server/src/tests/calendar.test.ts`

---

### A5. Edit the routine's master content (title/notes) in the app
**Given** routine `R` from A1 with future items already generated
**When** the user edits `R.title` and `R.template.notes` in the routine dialog
**Then**
- `R` is updated locally and the master event in GCal is updated (title + description)
- `propagateRoutineNotesToItems` updates all future (non-overridden) items' notes
- Items that already had per-instance overrides (`routineExceptions[date].notes` set) keep their overrides
- `R.lastPushedToGCalTs` is stamped; next inbound sync is suppressed

**Test location:** `api-server/src/tests/calendar.test.ts` + `client/src/tests/routineItemHelpers.test.ts`

---

### A6. Change the routine's RRULE in the app (whole series)
**Given** routine `R` from A1 (`FREQ=WEEKLY;BYDAY=MO`)
**When** the user changes the frequency to `FREQ=WEEKLY;BYDAY=TU`
**Then**
- The change is applied as a "this and following" split starting today (see section E for split semantics) — i.e. the original `R` gets `UNTIL=<today-1>`, a new tail routine is created with the new RRULE
- The master event in GCal is updated to UNTIL and a new recurring event is created for the tail
- Existing future items from `R` are deleted; new items for the tail are generated to horizon
- Past items (already completed/generated before the split date) are untouched

**Test location:** `client/src/tests/routineSplit.test.ts` + `api-server/src/tests/calendar.test.ts`

---

### A7. Delete the routine in the app
**Given** routine `R` from A1 with future items generated
**When** the user deletes `R` locally
**Then**
- `R` is removed (or marked inactive — confirm with implementation) locally
- All future items linked to `R` are trashed
- The master event in GCal is deleted (entire series cancellation)
- Past items (`done` or with `timeStart` already elapsed) are not modified

**Test location:** `api-server/src/tests/calendar.test.ts`

---

### A8. Complete a single instance in the app (calendar routine)
**Given** routine `R` from A1 with item `I` for today 09:00
**When** the user completes `I`
**Then**
- `I.status` becomes `done` locally
- The corresponding GCal occurrence is **not** deleted (completion is a local-only concept; GCal has no "done" state)
- `R.routineExceptions` is **not** mutated (completion ≠ override)
- Future items in the series are unchanged

**Test location:** `client/src/tests/routineItemHelpers.test.ts`

---

### A9. Make app-side change while offline, then reconnect
**Given** routine `R` from A1, item `I` for 2026-05-04
**When** the device is offline, the user edits `I.timeStart`, then reconnects
**Then**
- The pending op stays in `syncOperations` until reconnect
- On reconnect, `flushSyncQueue` pushes the change; GCal override is created
- If GCal received no conflicting edit during the offline window, behavior matches A2
- If GCal **did** receive a conflicting edit (see F1), conflict resolution applies

**Test location:** `client/src/tests/syncHelpers.test.ts`

---

## B. App-originated routine, then GCal-side change

### B1. Modify a single instance in GCal (time change)
**Given** routine `R` from A1 with item `I` for 2026-05-04 09:00
**When** the user opens GCal and changes that one occurrence to 11:00, then a sync runs
**Then**
- `syncRoutineExceptions` fetches the new exception (`type='modified'`, `start=...11:00`)
- `I.timeStart` and `I.timeEnd` are updated locally
- `R.routineExceptions` gains the override entry
- Master event RRULE is unchanged
- No echo back to GCal (the inbound update doesn't re-trigger an outbound push)

**Test location:** `api-server/src/tests/calendar.test.ts`

---

### B2. Modify a single instance in GCal (title/description change)
**Given** routine `R` from A1 with item `I` for 2026-05-04
**When** the user changes the title/description for that one occurrence in GCal, then sync runs
**Then**
- `I.title` is updated; `I.notes` is updated by converting GCal HTML description → markdown
- `R.routineExceptions` records the title/notes override
- `R.lastSyncedNotes` is **not** updated (that field tracks master-level notes, not exceptions — confirm)
- No echo

**Test location:** `api-server/src/tests/calendar.test.ts` + `api-server/src/tests/resolveInboundNotes.test.ts`

---

### B3. Delete a single instance in GCal
**Given** routine `R` from A1 with item `I` for 2026-05-04
**When** the user deletes that one occurrence in GCal, then sync runs
**Then**
- The exception (`type='deleted'`) is detected
- `I.status` becomes `trash` locally
- `R.routineExceptions` gains `{ date: '2026-05-04', type: 'skipped' }`
- Future generation skips that date
- Master event is unchanged

**Test location:** `api-server/src/tests/calendar.test.ts`

---

### B4. Edit the master event title/description in GCal
**Given** routine `R` from A1
**When** the user edits the master event's title/description in GCal ("apply to all events"), then sync runs
**Then**
- `R.title` and `R.template.notes` are updated (HTML → markdown)
- `R.lastSyncedNotes` is updated to the new HTML
- `R.updatedTs` is bumped
- Future, non-overridden items have their `notes` propagated
- Items with existing per-instance overrides keep their overrides
- No echo

**Test location:** `api-server/src/tests/calendar.test.ts` + `api-server/src/tests/resolveInboundNotes.test.ts`

---

### B5. Change the master RRULE in GCal (e.g. switch from MO to TU)
**Given** routine `R` from A1
**When** the user opens the master event in GCal, changes the recurrence pattern, applies to "all events", then sync runs
**Then**
- `R.rrule` is updated to the new RRULE
- Future items are regenerated against the new RRULE (existing non-matching items are trashed; new items are created)
- Past items (`timeStart < now`) are untouched
- No echo

**Test location:** `api-server/src/tests/calendar.test.ts` + `client/src/tests/routineItemHelpers.test.ts`

---

### B6. Change the master event time of day in GCal (e.g. 09:00 → 10:00)
**Given** routine `R` from A1 (09:00, 30min)
**When** the user changes the master event time to 10:00 (still 30min) and applies to all, then sync runs
**Then**
- `R.calendarItemTemplate.timeOfDay` is updated to `'10:00'` via `extractLocalTime` against the calendar's `timeZone`
- Future items have `timeStart` shifted to 10:00 (regenerated or in-place updated)
- Per-instance overrides (`routineExceptions[date].newTimeStart`) keep their overridden times
- No echo

**Test location:** `api-server/src/tests/calendar.test.ts`

---

### B7. Change the event duration in GCal
**Given** routine `R` from A1 (30min)
**When** the user changes the duration to 60min on the master event ("apply to all"), then sync runs
**Then**
- `R.calendarItemTemplate.duration` is updated to 60
- Future items have `timeEnd` recomputed
- Per-instance overrides keep their overridden durations
- No echo

**Test location:** `api-server/src/tests/calendar.test.ts`

---

### B8. Delete the master event in GCal (entire series cancellation)
**Given** routine `R` from A1
**When** the user deletes the entire series in GCal, then sync runs
**Then**
- `R.active` is set to `false` (deactivation, not hard delete — preserves history)
- All future items (non-completed, `timeStart >= now`) are trashed
- Past items and `done` items are kept
- See section I for further deactivation cases

**Test location:** `api-server/src/tests/calendar.test.ts`

---

## C. GCal-originated routine, then app-side change

### C1. Import existing GCal recurring event as a routine
**Given** an authenticated user with an existing GCal recurring event `E` (RRULE, time, description) and no matching local routine
**When** a sync runs
**Then**
- `importRecurringEventAsRoutine` creates routine `R` with:
  - `routineType='calendar'`
  - `rrule` extracted from `E.recurrence`
  - `calendarItemTemplate.timeOfDay` from `extractLocalTime(E.start, timeZone)`
  - `calendarItemTemplate.duration` = end − start
  - `template.notes` = HTML → markdown
  - `calendarEventId = E.id`, `calendarIntegrationId`, `calendarSyncConfigId`
  - `createdTs = E.start` (not sync time — preserves DTSTART anchoring)
  - `lastSyncedNotes = E.description` (raw HTML)
- Items are generated to horizon
- A subsequent sync within the same window does not re-import (idempotent)

**Test location:** `api-server/src/tests/calendar.test.ts`

---

### C2. Modify a single instance in the app, where routine was GCal-imported
**Given** routine `R` from C1, item `I` for next occurrence
**When** the user edits `I.timeStart` locally, change is flushed
**Then** identical behavior to A2 — origin does not affect override push semantics

**Test location:** `api-server/src/tests/calendar.test.ts`

---

### C3. Trash a single instance in the app, where routine was GCal-imported
**Given** routine `R` from C1, item `I`
**When** the user trashes `I` locally
**Then** identical behavior to A4

**Test location:** as A4

---

### C4. Delete the routine in the app, where routine was GCal-imported
**Given** routine `R` from C1
**When** the user deletes `R` locally
**Then** identical behavior to A7 — the GCal master event is deleted regardless of whether the routine originated locally or from GCal

**Test location:** as A7

---

### C5. Edit master content in the app, where routine was GCal-imported
**Given** routine `R` from C1
**When** the user edits `R.title` and `R.template.notes`
**Then** identical behavior to A5; `R.lastSyncedNotes` is updated when GCal acknowledges the push (or stays stale until the next inbound — confirm with implementation)

**Test location:** as A5

---

## D. GCal-originated routine, then GCal-side change

### D1. Modify a single instance in GCal, where routine was GCal-imported
**Given** routine `R` from C1, item `I`
**When** the user edits that one occurrence in GCal
**Then** identical behavior to B1 — origin does not affect inbound exception sync

**Test location:** as B1

---

### D2. Delete the master event in GCal, where routine was GCal-imported
**Given** routine `R` from C1
**When** the user deletes the entire series in GCal
**Then** identical behavior to B8 — `R.active = false`, future items trashed

**Test location:** as B8

---

### D3. Move the master event to a different calendar (within the same Google account)
**Given** routine `R` from C1 linked to calendar A
**When** the user moves the master event to calendar B (also synced) in GCal
**Then**
- The event disappears from calendar A's incremental sync (as cancelled)
- The event appears on calendar B's incremental sync as a new event
- **Expected behavior (to be designed):** either (a) `R.calendarSyncConfigId` is reassigned to calendar B's config, or (b) `R` is deactivated and a new routine is created for calendar B
- This case is currently **not implemented** — flag for design discussion

**Test location:** `api-server/src/tests/calendar.test.ts` (will likely require new code)

---

## E. "This and following" splits (both sides)

### E1. App-side split via routine RRULE change
**Given** routine `R` from A1 with items generated through 2026-08-01
**When** on 2026-05-15 the user changes `R`'s RRULE/time, choosing "this and all following"
**Then**
- `splitRoutine` runs:
  - `R.rrule` is capped: `addUntilToRrule(R.rrule, 2026-05-15)` → appends `UNTIL=20260514T235959Z`
  - Tail routine `R'` is created with the new RRULE/time, `splitFromRoutineId = R._id`, `createdTs = 2026-05-15T00:00:00Z`
  - Items from `R` with `timeStart >= 2026-05-15` are deleted
  - Items for `R'` are generated to horizon
- The master event `E` in GCal is updated with the UNTIL clause
- A new recurring event `E'` is created in GCal for `R'`
- `R'.calendarEventId = E'.id`
- Past items from `R` (before split date) are preserved

**Test location:** `client/src/tests/routineSplit.test.ts` + `api-server/src/tests/calendar.test.ts`

---

### E2. GCal-side split (user edits "this and following" in GCal UI)
**Given** routine `R` from C1 with items generated through 2026-08-01
**When** on 2026-05-15 the user edits the GCal series "this and all following" to a new time, then sync runs
**Then**
- GCal: original master event gains UNTIL=2026-05-14, new master event `E'` is created starting 2026-05-15
- `syncSingleCalendar` updates `R.rrule` to include UNTIL
- `detectAndLinkSplits` heuristic: new event `E'` starts within 0–2 days after `R`'s UNTIL → link as tail
- New routine `R'` is created with `splitFromRoutineId = R._id`, `calendarEventId = E'.id`
- Items from `R` with `timeStart > UNTIL` are trashed
- Items for `R'` are generated to horizon (server- or client-side; see open behavior #1)

**Test location:** `api-server/src/tests/calendar.test.ts`

---

### E3. App-side split, then GCal-side edit on the tail
**Given** split chain `R` (capped) → `R'` (tail) from E1
**When** the user edits `R'`'s master event in GCal (e.g. changes time)
**Then**
- Sync updates `R'.calendarItemTemplate.timeOfDay`
- `R'.splitFromRoutineId` is preserved (split chain remains intact)
- `R` is unaffected

**Test location:** `api-server/src/tests/calendar.test.ts`

---

### E4. GCal-side split, then app-side edit on the tail
**Given** split chain `R` → `R'` from E2
**When** the user edits `R'` in the app (e.g. changes title)
**Then**
- Outbound push updates `E'` master event in GCal
- `R'.splitFromRoutineId` preserved
- `R` unaffected

**Test location:** `api-server/src/tests/calendar.test.ts`

---

### E5. Repeated splits (split a tail again)
**Given** split chain `R` → `R'` from E1
**When** the user splits `R'` again at a later date
**Then**
- `R'` gains its own UNTIL
- New tail `R''` is created with `splitFromRoutineId = R'._id`
- The chain is `R` → `R'` → `R''`
- Each chain link has its own GCal master event

**Test location:** `client/src/tests/routineSplit.test.ts`

---

### E6. App-side split with one-instance override on the original
**Given** routine `R` with override on 2026-05-04 (modified time)
**When** the user splits `R` at 2026-05-15
**Then**
- The override on 2026-05-04 stays attached to `R` (before split date)
- `R'` (tail) starts fresh with no exceptions
- Items 2026-05-04 (overridden) and earlier remain on `R`

**Test location:** `client/src/tests/routineSplit.test.ts`

---

### E7. GCal-side split where the new tail has a different recurrence pattern
**Given** routine `R` from C1 (`FREQ=WEEKLY;BYDAY=MO`)
**When** the user does "this and following" in GCal and changes to `FREQ=WEEKLY;BYDAY=TU,TH`
**Then** behavior matches E2; `R'.rrule` reflects the new pattern; tail items appear on Tue/Thu

**Test location:** `api-server/src/tests/calendar.test.ts`

---

### E8. Detection ambiguity: new GCal event near a split boundary that is NOT a tail
**Given** routine `R` with UNTIL=2026-05-14 from a previous split
**When** the user creates an unrelated standalone recurring event `E_unrelated` starting 2026-05-15 in the same calendar (within the 0–2 day heuristic window)
**Then**
- `detectAndLinkSplits` may incorrectly link `E_unrelated` as a tail of `R` — **flag this as a known false-positive risk**
- Expected mitigation: detection should also require RRULE compatibility / similar `summary` (confirm with implementation)
- Test should assert current behavior and call out the gap if it exists

**Test location:** `api-server/src/tests/calendar.test.ts`

---

## F. Concurrent edits / conflict resolution

### F1. Same instance edited in app and GCal between syncs
**Given** routine `R` from A1, item `I` for 2026-05-04 09:00
**When** the user edits `I.timeStart` locally to 10:00 at T0, and also edits the GCal occurrence to 11:00 at T0+1s, then a sync runs at T0+10s
**Then**
- `resolveInboundNotes`-style last-write-wins applies (whichever has the later `updated`/`updatedTs` wins)
- If GCal wins (later `updated`): `I.timeStart = 11:00`, the local 10:00 edit is overwritten
- If app wins: `I.timeStart = 10:00`, the next outbound push corrects GCal
- No duplicate item; `R.routineExceptions` reflects the winning value

**Test location:** `api-server/src/tests/calendar.test.ts` + `api-server/src/tests/resolveInboundNotes.test.ts`

---

### F2. Master notes edited in app and GCal between syncs
**Given** routine `R` from A1
**When** the user edits `R.template.notes` locally and the master event description in GCal between syncs
**Then**
- `resolveInboundNotes` last-write-wins on timestamps:
  - Compares GCal `event.updated` vs `R.updatedTs`
  - Uses `lastSyncedNotes` to detect whether GCal description actually changed (avoids spurious overwrites)
- Winning notes are applied; `R.lastSyncedNotes` updated to GCal HTML on next sync
- Future, non-overridden items get the winning notes via `propagateRoutineNotesToItems`

**Test location:** `api-server/src/tests/resolveInboundNotes.test.ts`

---

### F3. Echo suppression: app push then immediate webhook
**Given** routine `R` from A1
**When** the app pushes a master-event update at T0; GCal webhook fires at T0+1s; sync pull processes the event with `event.updated ≈ T0`
**Then**
- `isOwnEcho(R.lastPushedToGCalTs, event.updated)` returns `true` (within 5s window)
- The event is **not** re-applied locally
- `R.updatedTs` is unchanged from the push

**Test location:** `api-server/src/tests/calendar.test.ts`

---

### F4. Echo window expired (slow webhook delivery)
**Given** the same setup as F3
**When** the webhook is delayed and sync runs at T0+10s
**Then**
- `isOwnEcho` returns `false` (outside 5s window)
- Defense in depth: `lastSyncedNotes` comparison still suppresses redundant notes updates if content is identical
- For non-notes fields (time, RRULE), the inbound update is applied (idempotent — same value as already stored)
- No infinite loop because the next outbound push compares `R.updatedTs` and skips if nothing changed

**Test location:** `api-server/src/tests/calendar.test.ts`

---

### F5. App-side delete of instance, GCal-side modify of same instance
**Given** routine `R` from A1, item `I` for 2026-05-04
**When** at T0 the user trashes `I` locally; at T0+1s the user edits the same GCal occurrence's time; sync runs at T0+10s
**Then**
- Deletion takes precedence (item is trashed; the modify exception is ignored or the item is re-created in trashed state — confirm intended behavior)
- `R.routineExceptions` records `type='skipped'` for that date
- No GCal-side event is restored

**Test location:** `api-server/src/tests/calendar.test.ts`

---

### F6. App-side master delete, GCal-side concurrent instance edit
**Given** routine `R` from A1
**When** the user deletes `R` locally at T0; concurrently a GCal user edits one occurrence at T0+1s; sync runs at T0+10s
**Then**
- The master event delete propagates to GCal, cancelling the entire series
- The GCal-side instance edit becomes orphaned (ignored)
- No leftover items for `R` remain locally

**Test location:** `api-server/src/tests/calendar.test.ts`

---

## G. Timezone changes

### G1. User changes their default calendar's timezone in GCal settings
**Given** routine `R` from A1 created with calendar timezone `America/New_York`, items generated for 09:00 ET
**When** the user changes the calendar's timezone in GCal to `America/Los_Angeles`, then sync runs
**Then**
- `CalendarSyncConfig.timeZone` is refreshed to `America/Los_Angeles`
- The master event's `start.timeZone` updates accordingly in GCal
- **Open question (flag for design):** should existing items keep their wall-clock time (09:00) or absolute time (06:00 PT = 09:00 ET)?
- Currently: `calendarItemTemplate.timeOfDay` is a naive local time, so future-generated items will use the new timezone's 09:00 (wall-clock preserved)
- Past items (`timeStart < now`) are not retroactively shifted

**Test location:** `api-server/src/tests/calendar.test.ts` + `api-server/src/tests/rruleHelpers.test.ts`

---

### G2. Master event timezone changed in GCal (without changing time of day)
**Given** routine `R` from A1, master event timezone `America/New_York`
**When** the user opens the master event in GCal and changes its timezone to `Europe/London` (keeping the displayed time as 09:00)
**Then**
- On sync, `extractLocalTime(event.start, calendar.timeZone)` recomputes `timeOfDay`
- Behavior depends on whether GCal returns `event.start` in the event's TZ or the calendar's TZ — needs explicit assertion
- Future items reflect the new timezone interpretation
- Per-instance overrides keep their stored times

**Test location:** `api-server/src/tests/calendar.test.ts`

---

### G3. Routine straddles a DST transition
**Given** routine `R` weekly Mondays 09:00 in `America/New_York`, items generated through 2026-04-01 (across the spring DST transition on 2026-03-08)
**When** items are generated for dates before and after DST
**Then**
- All items have `timeStart` at local 09:00 (wall-clock preserved across DST)
- UTC times shift by 1 hour at the DST boundary
- `RoutineExceptions` dates remain ISO date-only (no DST ambiguity)
- GCal master event correctly reflects the rule and DST is handled by GCal natively

**Test location:** `api-server/src/tests/rruleHelpers.test.ts` + `client/src/tests/rruleUtils.test.ts`

---

### G4. User in a different timezone than the calendar
**Given** routine `R` linked to a calendar in `America/New_York`, but the user's device is in `Asia/Tokyo`
**When** items are generated and displayed
**Then**
- Items are stored with `timeStart` as naive local strings matching the calendar's `timeZone` (09:00 ET)
- The client renders them in the user's local timezone (e.g. 22:00 JST) — this is a UI concern, not a storage concern
- Sync round-trips do not corrupt the stored time
- GCal master event time matches (09:00 ET)

**Test location:** `api-server/src/tests/calendar.test.ts`

---

## H. UNTIL boundary / series end

### H1. Routine reaches its UNTIL date naturally
**Given** routine `R` with `RRULE=FREQ=WEEKLY;BYDAY=MO;UNTIL=20260615T235959Z`
**When** time advances past 2026-06-15
**Then**
- No new items are generated past the UNTIL date
- `R.lastGeneratedDate` does not advance past UNTIL
- `R.active` may be set to `false` once past UNTIL (confirm intended behavior)
- Master event in GCal naturally ends — no event-cancelled signal needed

**Test location:** `client/src/tests/routineItemHelpers.test.ts`

---

### H2. Routine reaches its COUNT limit
**Given** routine `R` with `RRULE=FREQ=WEEKLY;BYDAY=MO;COUNT=10`
**When** all 10 items are generated and time advances past the 10th
**Then**
- No 11th item is generated
- `R.lastGeneratedDate` reflects the 10th occurrence
- Master event in GCal naturally ends after 10 occurrences

**Test location:** `client/src/tests/routineItemHelpers.test.ts`

---

### H3. UNTIL is added to a routine via app-side edit
**Given** routine `R` from A1 (no UNTIL), items generated through 2026-08-01
**When** the user edits `R` to add `UNTIL=20260615T235959Z`
**Then**
- `R.rrule` is updated to include UNTIL
- Items with `timeStart > 2026-06-15` are trashed
- Items on or before 2026-06-15 are kept
- Master event in GCal is updated with the UNTIL clause

**Test location:** `client/src/tests/routineItemHelpers.test.ts` + `api-server/src/tests/calendar.test.ts`

---

### H4. UNTIL is added to the master event in GCal
**Given** routine `R` from C1 (no UNTIL), items generated through 2026-08-01
**When** the user edits the master event in GCal to set an end date of 2026-06-15, then sync runs
**Then**
- `R.rrule` gains the UNTIL clause via inbound sync
- Items with `timeStart > UNTIL` are trashed
- Items on or before are kept
- No outbound echo

**Test location:** `api-server/src/tests/calendar.test.ts`

---

### H5. UNTIL is removed/extended from the master event in GCal
**Given** routine `R` with `UNTIL=20260615T235959Z` and items only through that date
**When** the user removes UNTIL or extends it to 2026-12-31 in GCal, then sync runs
**Then**
- `R.rrule` is updated (UNTIL removed or extended)
- Item generation resumes; `generateCalendarItemsToHorizon` creates items for the newly opened range
- Past trashed items (from the previous UNTIL) are not resurrected — they remain trashed

**Test location:** `api-server/src/tests/calendar.test.ts` + `client/src/tests/routineItemHelpers.test.ts`

---

### H6. UNTIL boundary intersects with horizon
**Given** routine `R` with `UNTIL=20260615T235959Z`, horizon ends 2026-08-01
**When** items are generated
**Then**
- Items are generated up to `min(UNTIL, horizon)` = 2026-06-15
- No items beyond UNTIL even if horizon would allow more
- `R.lastGeneratedDate` = the last occurrence ≤ 2026-06-15

**Test location:** `client/src/tests/routineItemHelpers.test.ts`

---

### H7. Per-instance override on the last occurrence before UNTIL
**Given** routine `R` with UNTIL=2026-06-15, last occurrence 2026-06-15
**When** the user modifies that last occurrence in GCal (e.g. moves it to 2026-06-20, past UNTIL)
**Then**
- The exception is recorded on `R.routineExceptions[date='2026-06-15']` with `newTimeStart=2026-06-20`
- The local item for that date has its `timeStart` updated to 2026-06-20
- No new items are generated beyond UNTIL (the override is a one-off, not a recurrence extension)

**Test location:** `api-server/src/tests/calendar.test.ts`

---

## I. Routine deactivation (GCal master deleted)

### I1. Master event deleted in GCal — basic deactivation
**Given** routine `R` from C1 with future items generated
**When** the user deletes the entire series in GCal, then sync runs
**Then**
- `R.active = false`
- All items with `status='calendar'` and `timeStart >= now` linked to `R` are trashed
- Items with `status='done'` are kept (history preserved)
- Past items (`timeStart < now`, status `calendar`) are kept
- `R.calendarEventId`, `R.calendarIntegrationId` remain populated (audit trail) — confirm

**Test location:** `api-server/src/tests/calendar.test.ts`

---

### I2. Master event deleted in GCal, then user reactivates routine in app
**Given** routine `R` deactivated via I1
**When** the user re-activates `R` in the app (sets `active=true` and edits the routine to re-link to a calendar)
**Then**
- A new master event is created in GCal
- `R.calendarEventId` is replaced with the new event's ID
- Items are regenerated to horizon
- Previously trashed items are not resurrected

**Test location:** `client/src/tests/routineItemHelpers.test.ts` + `api-server/src/tests/calendar.test.ts`

---

### I3. Master event deleted in GCal — exception sync after deactivation
**Given** routine `R` deactivated via I1
**When** subsequent syncs run
**Then**
- `R` is excluded from `syncRoutineExceptions` (no exception fetch attempted on a cancelled event)
- No errors are logged for the missing event
- `R.lastPushedToGCalTs` is not updated

**Test location:** `api-server/src/tests/calendar.test.ts`

---

### I4. Master event recreated by GCal user with same recurrence after deletion
**Given** routine `R` deactivated via I1
**When** the user creates a new recurring event in GCal with the same title/RRULE/time, then sync runs
**Then**
- The new event is treated as a **new routine** (different `calendarEventId`)
- `R` remains deactivated; a fresh routine `R_new` is created
- No automatic "resurrection" of `R` based on title/RRULE matching

**Test location:** `api-server/src/tests/calendar.test.ts`

---

### I5. Routine with split chain — master deleted on the original (capped) routine
**Given** split chain `R` → `R'`, where `R` has UNTIL and `R'` is active
**When** the user deletes `R`'s (now-ended) master event in GCal
**Then**
- `R.active = false` (already had no future items because of UNTIL — no-op for items)
- `R'` is unaffected (different `calendarEventId`)
- Split chain reference (`R'.splitFromRoutineId = R._id`) is preserved

**Test location:** `api-server/src/tests/calendar.test.ts`

---

### I6. Routine with split chain — master deleted on the tail
**Given** split chain `R` → `R'`, where `R'` is active with future items
**When** the user deletes `R'`'s master event in GCal
**Then**
- `R'.active = false`, future items trashed (per I1)
- `R` is unaffected
- Chain reference preserved

**Test location:** `api-server/src/tests/calendar.test.ts`

---

## J. Webhook / sync token expiry / disconnected integration

### J1. Sync token expires (410 Gone)
**Given** `CalendarSyncConfig` with `syncToken` older than 28 days
**When** sync runs and `listEventsIncremental(calendarId, syncToken)` returns 410
**Then**
- Fall back to `listEventsFull(lastSyncedTs)` for the calendar
- All events since `lastSyncedTs` are re-imported
- Echo suppression (`lastPushedToGCalTs`, `lastSyncedNotes`) prevents duplicate updates for unchanged events
- New `syncToken` is stored on the config
- No data loss; no duplicate routines

**Test location:** `api-server/src/tests/calendar.test.ts`

---

### J2. Webhook channel expires
**Given** `CalendarSyncConfig` with `webhookExpiry` in the past
**When** the next sync runs
**Then**
- The webhook channel is renewed (new `webhookChannelId`, `webhookResourceId`, `webhookExpiry`)
- The old channel is closed (best-effort) on Google's side
- Sync continues normally
- No duplicate webhook deliveries (each delivery includes `webhookResourceId`)

**Test location:** `api-server/src/tests/calendar.test.ts`

---

### J3. Webhook delivery received for an expired/unknown channel
**Given** a webhook delivery arrives with a `webhookResourceId` not matching any current `CalendarSyncConfig`
**When** the webhook handler processes it
**Then**
- The delivery is ignored (no sync triggered)
- A warning is logged
- No 5xx response (Google would retry indefinitely)

**Test location:** `api-server/src/tests/calendar.test.ts` (webhook handler)

---

### J4. App stays offline past webhook expiry
**Given** the app has not synced for 7+ days; webhook expired during that window
**When** the app comes back online and triggers a manual sync
**Then**
- Sync token is likely also expired → 410 fallback to full sync (J1 path)
- Webhook is renewed (J2 path)
- All changes since `lastSyncedTs` are picked up via full sync
- No data loss

**Test location:** `api-server/src/tests/calendar.test.ts`

---

### J5. User revokes app access in Google Account security page
**Given** `CalendarIntegration` with valid tokens at the start
**When** the user revokes access in https://myaccount.google.com/permissions, then a sync runs
**Then**
- Token refresh fails with `invalid_grant`
- The integration is marked as needing re-authentication (e.g. a `needsReauth` flag — confirm field name)
- Sync stops gracefully; no exceptions propagate to the user
- Routines and items remain intact locally; outbound pushes are queued or dropped (confirm)
- The UI surfaces a "reconnect Google Calendar" prompt
- No further sync attempts until reconnected

**Test location:** `api-server/src/tests/calendar.test.ts` + `client/src/tests/syncHelpers.test.ts`

---

### J6. User reconnects after revocation
**Given** integration in `needsReauth` state from J5
**When** the user re-authenticates via OAuth flow
**Then**
- New tokens are stored on the existing `CalendarIntegration` (preserving `_id` and routine links)
- `needsReauth` flag is cleared
- A fresh sync runs:
  - `syncToken` may be invalid → 410 fallback (J1)
  - `webhook` is re-registered
- All changes that occurred during the disconnected window are picked up
- Routines previously linked to this integration resume bidirectional sync seamlessly

**Test location:** `api-server/src/tests/calendar.test.ts`

---

### J7. Refresh token expired but not revoked (long inactivity)
**Given** `CalendarIntegration` unused for 6+ months; refresh token has expired per Google's policy
**When** sync attempts to refresh
**Then** identical behavior to J5 — surfaces as `invalid_grant`, requires re-auth

**Test location:** `api-server/src/tests/calendar.test.ts`

---

### J8. Integration deleted entirely (user disconnects from app side)
**Given** `CalendarIntegration` with linked routines
**When** the user deletes the integration in the app
**Then**
- `CalendarIntegration` and all `CalendarSyncConfig` records are removed
- Linked routines have their `calendarEventId`, `calendarIntegrationId`, `calendarSyncConfigId` cleared
- Routines remain `active=true` locally with their items intact (the routine is still useful as a local-only routine)
- Master events in GCal are **not** deleted (user-initiated disconnect ≠ delete intent — confirm desired behavior)
- Webhook channels are closed (best-effort)

**Test location:** `api-server/src/tests/calendar.test.ts`

---

### J9. Sync runs while integration is mid-deletion
**Given** integration deletion in flight
**When** a webhook fires and triggers a sync for the same integration
**Then**
- The sync gracefully no-ops (integration not found)
- No partial state corruption
- No 5xx error returned to Google

**Test location:** `api-server/src/tests/calendar.test.ts`

---

## Cross-cutting concerns / open questions to resolve before implementation

These questions surfaced while writing the matrix. Resolving them will sharpen several test expectations:

1. **A7/J8 — routine deletion vs. integration deletion:** Should deleting a routine in the app delete the GCal master event, or just unlink? Same question for integration deletion. Currently A7 assumes "delete"; J8 assumes "unlink".
2. **B2 — `lastSyncedNotes` for exceptions:** Does the field track only the master's notes, or per-exception notes too?
3. **B5/B6 — in-place item update vs. regenerate:** When the master RRULE/time changes, do future items get updated in-place (preserving `_id`) or trashed-and-recreated?
4. **D3 — moving a master event between calendars:** How should this be represented? Currently flagged as not implemented.
5. **E8 — split detection false positives:** Is RRULE compatibility part of the heuristic? If not, should it be?
6. **G1/G2 — wall-clock vs. absolute time on TZ change:** What's the intended user experience?
7. **H1 — auto-deactivation on UNTIL:** Does `R.active` flip to `false` when UNTIL is passed, or does it stay `true` indefinitely?
8. **I1 — preserving link metadata after deactivation:** Do `calendarEventId` etc. get cleared, or kept for audit?
9. **J5 — outbound push behavior during `needsReauth`:** Are queued ops dropped, retried later, or held forever?
