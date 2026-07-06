---
name: routine-open-item-merge-phase3-wiring
description: Phase 3 will wire routineOpenItemMerge/rruleCanonical into PATCH /v1/routines — review-checklist for that follow-up PR
metadata:
  type: project
---

`src/lib/routineOpenItemMerge.ts` + `src/lib/rruleCanonical.ts` landed as pure Phase-1 helpers (approved 2026-07-05). Phase 3 wires them into `PATCH /v1/routines/:id`, replacing `restampOpenItemForStartDateChange` with an unconditional recompute + content propagation.

**Why:** feature = routine edits immediately propagate to the routine's single open generated item.

**How to apply — checklist for the Phase-3 wiring PR:**
- `mergeRoutineEditIntoOpenItem` returns a full item snapshot with `updatedTs = edit.now`. Wiring it through `applyAndPublishOperation` at `now` is the exact find→build-snapshot→apply(now) pattern that defeats LWW on concurrent client edits — see [[snapshot-replace-defeats-lww-on-concurrent-edits]]. Demand a conditional updateOne or per-item re-read.
- `computeFirstOccurrenceDate(routine, localTodayStr)` mirrors `computeFirstAnchor` — but the server currently derives `localTodayStr` from `dayjs().format('YYYY-MM-DD')` which is SERVER-local, not the caller's TZ. Same server-local-day caveat as [[spend-cap-local-day-and-throw-path-gaps]]. Public-API caller has no client tick; flag TZ correctness.
- Server `isNextActionScheduleChanged(previous, next)` takes two full routines and folds startDate into the predicate; the CLIENT twin takes `(previous, RoutineEditIntent)` and only compares rrule (startDate via separate `isStartDateChanged`). Signatures intentionally differ — do NOT flag as mirror drift. The test matrices diverge only in that describe block for this reason.
- Stamping-rule parity: `stampedItemContent` must stay key-for-key with `buildRoutineItemSnapshot` (truthy for workContextIds/peopleIds/energy/notes; `!== undefined` for time/focus/urgent). If someone adds a template field to one generator, both + `OPTIONAL_STAMPED_KEYS` must move together.
