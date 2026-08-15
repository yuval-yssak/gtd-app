---
name: rrule-freq-branch-ignores-byday
description: rrule-derived helpers branch on FREQ first and return early, silently ignoring BYDAY/UNTIL/COUNT that narrow the same rule — check every new rrule reader against DAILY;BYDAY and expired UNTIL
metadata:
  type: feedback
---

Every new rrule-reading helper in `client/src/lib/` (formatRrule, approxIntervalDays,
fixedWeekdaysOf, …) is written as a `if (freq === DAILY) return …` ladder that returns before
looking at the other options on the same rule. Two shapes fall through the cracks every time:

- **`FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR`** — Google Calendar's standard "every weekday" recurrence,
  and a shape already present in `storybookMocks.ts`. The DAILY branch fires and the BYDAY
  restriction is dropped, so the routine reads as firing all 7 days.
- **`UNTIL=` / `COUNT=` already exhausted** — the helper describes a series that is over as if it
  still recurs. Split heads dodge this because `routineSplit` sets `active:false`, but
  GCal-imported series keep `active:true` past their UNTIL.
- **positional `BYDAY=2TH` under WEEKLY** — degenerate but parses to a bare weekday.

**Why:** GCal-imported rrules are stored verbatim (`api-server/src/routes/calendar.ts`
`extractRrule`), so the client sees arbitrary RFC-5545 rules, not just the subset FrequencyPicker
can emit. Reviewing against picker-producible rules alone misses the imported ones.

**How to apply:** when a diff adds or edits any function that calls `RRule.fromString`, assert the
three shapes above against it before approving. Unit tests for these helpers consistently cover
only picker-producible rules, so the test file passing is not evidence.

Related: [[feedback-conditional-render-gate-loses-coverage]]
