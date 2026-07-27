---
name: timestart-offset-lexicographic-compare
description: item.timeStart stores GCal's raw offset-form dateTime (+03:00), so string-comparing it against a UTC `now` misclassifies same-day items in BOTH directions
metadata:
  type: project
---

`item.timeStart` is stored verbatim from Google's `start.dateTime`
(`calendarProviders/GoogleCalendarProvider.ts:290`), i.e. in the **event's own UTC offset**
(`2026-08-01T09:00:00+03:00`), NOT normalized to UTC. Server-side `now` is
`dayjs().toISOString()` — always `...Z`. Comparing the two as strings is wrong in both directions:

- `'2026-07-27T14:00:00+03:00' >= '2026-07-27T12:00:00.000Z'` → true, but the real instant is
  11:00Z — an hour in the **past**. False positive.
- `'2026-07-27T11:30:00-05:00' >= now` → false, but the real instant is 16:30Z — **future**.
  False negative.
- Date-only all-day values (`'2026-07-28'`, 10 chars) sort *after* a 24-char `now` string for the
  same day, so today's all-day events are also misread.

**Why:** found on the P4 sync-doctor phantom-item check (fixed there with
`!dayjs(timeStart).isBefore(dayjs(now))` + an explicit `timeStart !== undefined` guard — note
`dayjs(undefined)` is *now*, which would silently count timeless items as future).

**How to apply:** Flag any `timeStart` compared with `>=`/`>`/`<` against a UTC `now`, including
Mongo range queries (`{ timeStart: { $gte: now } }`) — Mongo compares BSON strings the same way.
This pattern is still present in pre-existing code (`routes/calendar.ts` ~1829/3320/3521,
`lib/routineItemRegeneration.ts:330`, `scripts/retireOrphanedSeriesSuccessor.ts:139/148`); those
are mostly same-day-boundary-tolerant by luck, not by design. Not this-delta bugs, but worth a
follow-up sweep. Fixture warning: a test using a far-future and a far-past date passes under BOTH
the correct and the buggy compare — only a **same-day** offset fixture discriminates (see
[[feedback_guard_predicate_boundary_needs_branch_proof]]).
