---
name: floating-datetime-shared-across-item-and-routine
description: floatingDateTime zod schema is shared by Item.timeStart/timeEnd AND routineExceptions[].newTimeStart/newTimeEnd — any widening/tightening hits both surfaces silently.
metadata:
  type: project
---

`floatingDateTime` in `schemas/operations/shared.ts` is imported by BOTH `item.ts` (timeStart/timeEnd) and `routine.ts` (routineExceptions[].newTimeStart/newTimeEnd). It now accepts three shapes: offset-suffixed ISO, timezone-naive `YYYY-MM-DDTHH:MM:SS`, and (as of the all-day fix) date-only `YYYY-MM-DD`.

**Why:** The all-day calendar completion 400 fix widened it for items, but the same change silently made date-only `newTimeStart` valid on routine exceptions — a shape the server-side GCal parser (`GoogleCalendarProvider.ts`) never emits, so it can only arrive via a client-pushed routine snapshot.

**How to apply:** On any change to `floatingDateTime`, check BOTH consumers and demand a test on each surface. Routine-exception consumers that rely on the date shape: `routineItemRegeneration.ts` (`newTimeStart.slice(0,10) !== e.date` cross-date detection) and `calendar.ts` `isExceptionBeforeToday` / modified-exception apply (`.slice(0,10)` or raw assign to timeStart/timeEnd). All tolerate date-only via slice today, but a tightening on the item side would break routine exceptions from the opposite direction — see [[id-normalization-asymmetry-pattern]]. Also note: the date-only regex `^\d{4}-\d{2}-\d{2}$` is duplicated in 3 places in shared.ts (floatingDateTime, isoDate, isoDateOrDateTime) and accepts invalid calendar dates like 2026-13-45 (shape-only, consistent codebase posture).
