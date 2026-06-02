---
name: reconcile-window-end-sliver-asymmetry
description: getExceptions-mirroring reconcile windows fix the floor sliver but leave the symmetric now+1y windowEnd sliver open (inclusive date <= vs provider's instant timeMax).
metadata:
  type: project
---

In `reconcileRemovedExceptions` (calendar.ts), the eligibility window must mirror `GoogleCalendarProvider.getExceptions`' real bounds: timeMin = `max(since, now-30d)` (instant), timeMax = `now+1y` (instant). The reconcile only has each exception's `YYYY-MM-DD`, so date-vs-instant truncation creates a one-day-wide data-loss sliver at EACH boundary: an instance ON the boundary date but on the wrong side of the boundary *instant* is excluded by the provider yet rounds into a date-only window → wrongly reverted + dropped.

The floor was fixed with strict `date > floorDate`. The windowEnd was left INCLUSIVE (`date <= windowEnd`) — same bug, mirrored at `now+1y`. Fix is symmetric: `date < windowEnd`.

**Why:** This is the same date-vs-datetime truncation class as [[project_reconcile_window_date_vs_datetime_truncation]] and [[project_getexceptions_window_anchored_to_since]] — provider uses ISO instants, reconcile uses truncated dates; every boundary needs strict comparison on the truncated side.

**How to apply:** On any reconcile/window predicate that mirrors a provider time-range query, check BOTH boundaries for the date-vs-instant sliver, not just the one the author reasoned about. Demand a preserve-test on each boundary (the windowEnd test depends on wall-clock time-of-day — anchor `now` or pick a late instance time to avoid midnight-UTC flakiness).
