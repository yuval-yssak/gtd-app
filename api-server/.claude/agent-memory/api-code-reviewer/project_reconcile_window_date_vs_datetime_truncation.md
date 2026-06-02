---
name: reconcile-window-date-vs-datetime-truncation
description: Reconcile-on-absence windows that mirror getExceptions' timeMin must compare on the ISO instant, not a YYYY-MM-DD truncation, or a same-day boundary sliver silently reverts valid exceptions.
metadata:
  type: project
---

`reconcileRemovedExceptions` in `routes/calendar.ts` must mirror `GoogleCalendarProvider.getExceptions`' query bounds to decide which local `modified` exceptions are eligible for removal-on-absence. The first fix mirrored the floor selection (`max(since, now-30d)`) correctly but then `.format('YYYY-MM-DD')`-truncated `windowStart` and compared `ex.date >= windowStart` as date strings.

**The bug:** the provider's `timeMin` is `since`'s full ISO datetime and returns instances where `instanceStart >= timeMin`. Truncating to the date drops the time-of-day, so an exception whose `originalDate == since`'s calendar date but whose master instance time is earlier-in-day than `since` is excluded by the provider yet counted `isInWindow` → falsely reverted + dropped. Same silent-data-loss class the fix targeted, surviving on the `since`-date boundary. Reachable: master template time and `lastSyncedTs` time-of-day are both arbitrary.

**Why:** This is the same family as [[project_getexceptions_window_anchored_to_since]] — reconcile/window predicates that don't faithfully reproduce the provider's real `timeMin = max(since, now-30d)` over- or under-reconcile.

**How to apply:** On any reconcile-on-absence / window-membership check that mirrors a GCal time query, compare on the ISO instant, not a date truncation. The safe direction at the lower bound is end-of-day (or exclude the `since`-date entirely) so it errs toward preserving the exception — a missed revert self-heals next sync; a false revert is silent loss. Demand a same-day boundary test: master at 09:00, `lastSyncedTs` at `${sinceDate}T14:30`, exception dated exactly `sinceDate`, getExceptions→[] → must be preserved. Also watch the secondary wrinkle: `since` is UTC ISO but `.format('YYYY-MM-DD')` resolves in server-local TZ while exception dates are calendar-TZ.
