---
name: no-hardcoded-dates-in-calendar-tests
description: Calendar/GCal tests must derive dates from dayjs() relative to today, never hardcode absolute Ymd literals — past-cutoff guards age them into skipping the code under test.
metadata:
  type: feedback
---

Calendar exception/sync tests must derive dates as `dayjs().add(N, 'day')` (and matching `YYYYMMDD` compact form for `gcal-evt-master_…Z` instance ids), not hardcoded `'2026-05-26'`-style literals.

**Why:** `applyExceptionToItems` has a past-cutoff guard (`isExceptionBeforeToday`, calendar.ts) that compares `ex.newTimeStart` (or `originalDate`) slice(0,10) against `dayjs(ctx.now).tz(ctx.timeZone).format('YYYY-MM-DD')`. Any hardcoded date silently becomes < today as the system clock advances and the test no longer reaches `createItemForOrphanedException` / `applyExceptionAfterDuplicate` — it just hits the past-cutoff short-circuit and the assertions stop being meaningful. Three `dead-twin demote` tests aged into this in May 2026 and only failed because of an unrelated mutation; the past-cutoff fix landed without anyone updating them.

**How to apply:** when reviewing GCal exception tests, flag any literal date string used as `originalDate`, `newTimeStart`, `newTimeEnd`, or inside `gcal-evt-master_…Z`. Require the test derive a single `dayjs().add(7, 'day')` (≥7 days is safe across any plausible TZ skew between runner-local and `config.timeZone`, which defaults to `'Asia/Jerusalem'` in `insertIntegrationWithConfig`). All Ymd derivations must come from the same `dayjs` object so the compact `YYYYMMDD` and dashed `YYYY-MM-DD` agree on the calendar date.

Related: this is the same class of bug as date-keyed lookups missing after a prior shift in [[project_gcal_moved_instance_lost_when_already_moved]] — hardcoded test dates and date-keyed production lookups both fail silently when the date stops matching reality.
