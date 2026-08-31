---
name: module-singleton-stale-snapshot
description: Module-singleton stores seed their snapshot at import time but only refresh it on a subscribed event — the import→first-subscriber gap silently serves stale data.
metadata:
  type: feedback
---

When reviewing a module-level `useSyncExternalStore` store, check whether the snapshot is
seeded at **module evaluation** but only recomputed inside the event/timer handler. If
`subscribe()` arms the source without re-deriving the snapshot, everything that changed
between import and the first subscriber is silently absorbed.

**Why:** this app has no route code-splitting, so every `lib/*` module evaluates at page load,
while `_authenticated.tsx` Suspends on the app-data resource — the first consumer can mount many
seconds (a slow bootstrap: minutes) later. Anything time-derived (the day clock's `todayIso`) or
externally-mutable seeded at import is stale by the time React first reads it. Found in the
tickler day-clock review: `let todayIso = dayjs().format(...)` at module scope + a
`startDayClockOnce()` that armed a timer but never re-derived, so loading the app just before
local midnight and finishing bootstrap just after showed yesterday's tickler set until the *next*
midnight.

**How to apply:** for any module-singleton store, ask two questions —
(1) does `subscribe()` re-derive the snapshot before returning? and
(2) does the last `unsubscribe()` tear the source down (or is a leaked timer/listener intended)?
The existing `lib/listGhosts.ts` is the house pattern to compare against. Related:
[[feedback-tz-dependent-date-tests]].
