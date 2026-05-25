---
name: stale-snapshot-after-inplace-heal
description: When a function heals/rewrites entity fields in place inside a sub-call, subsequent uses of the original snapshot in the same outer function re-trigger the heal and pollute the op log.
metadata:
  type: feedback
---

If a function `A` calls `B(snapshot)` and `B` heals/mutates the entity row in the DB (e.g. rewriting `calendarIntegrationId`, `calendarSyncConfigId`), any subsequent call `A` makes that also passes the same `snapshot` will see *stale* link fields and re-trigger the heal path. This produces duplicate server-origin ops for the same logical change.

Concrete case (calendarPushback.ts): `pushRoutineResume(snapshot)` calls `pushExistingRoutineToGCal(snapshot)` which heals a stale link via `tryHealStaleLink`, then calls `resolveTimeZoneForRoutine(snapshot)` which re-enters the same heal path because `snapshot` still has the pre-heal ids. Result: 2 heal ops per resume.

**Why:** in-place heal is a useful pattern (avoids forcing every caller to re-read), but breaks for callers that pass the snapshot to multiple downstream functions.

**How to apply:**
- When reviewing code that heals/rewrites entity fields inside a helper, check if the *caller* uses the same snapshot afterwards. If yes, either: (a) re-fetch from DB between calls, (b) thread the post-heal snapshot back to the caller, or (c) move the heal to the outer function so it happens once.
- Tests should fire the operation against a stale-link entity and assert the count of resulting server-origin ops is exactly 1, not "at least 1".
- This pattern also applies to any future in-place healing logic (e.g. healing stale `peopleId` / `workContextId` references) — same trap.
