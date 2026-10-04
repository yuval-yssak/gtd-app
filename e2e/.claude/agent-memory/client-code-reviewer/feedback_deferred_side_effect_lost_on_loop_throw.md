---
name: deferred-side-effect-lost-on-loop-throw
description: Moving a side effect from inside a per-user loop to "after the finally" (collect ids, act later) silently drops it whenever a later iteration throws
metadata:
  type: feedback
---

Collect-then-act refactors (`mapSequentially(...)` returning deleted ids, evaporated after `restorePreviouslyActiveSession`) lose the collected work when any later pass rejects — the `.finally` restores, the error propagates, the list is discarded. Found 2026-10-04: a tombstoned account found in pass 1 was never evaporated if pass 2 threw a non-auth error, and the probe throttle (stamped on the `deleted` answer) hid it from the next pre-loop probe for 10 minutes; no reauth flag either, so the dead account rendered silently.

**Why:** the fix for an ordering bug is reviewed against the ordering test only; nobody tests "earlier iteration's outcome + later iteration throws".

**How to apply:** for any deferred-collection change, ask what happens to entries collected before a throw; demand either per-iteration error capture or a durable marker (e.g. don't throttle terminal answers), plus a test with pass-1 outcome + pass-2 rejection. Related: [[fallback-navigation-clobbers-specific-one]].
