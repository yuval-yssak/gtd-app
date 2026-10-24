---
name: project-routine-open-item-lock-coverage
description: ROUTINE_ITEMS_LOCK (2026-10) covers only materializer + done/trash disposal; routine create/split/editor seed paths still check-then-write unlocked. Also per-file navigator.locks fakes drift.
metadata:
  type: project
---

The "at most one open item per nextAction routine" invariant was first serialized in 2026-10 (chore/deps-update) via a Web Lock taken by `materializePendingNextActionRoutines` and done/trash disposal only. Routine creation (`createRoutineWithFirstItems`), split tail seeding, and the routine editor's `hasOpenRoutineItem`-then-seed still run outside it, so a cross-tab materializer pass between "routine row written" and "first item written" can still mint a duplicate.

**Why:** the duplicate-occurrence bug surfaced only as an e2e flake (tickler-midnight-rollover); the fix was scoped to the observed gap.

**How to apply:** when a change touches any routine item seeding path, ask whether it runs under the routine-items lock. Also: test files each hand-roll their own `navigator.locks` fake; a 2-arg-only fake silently no-ops the flush's 3-arg `{ signal }` request — push for a shared fake (see [[project-new-lib-module-ships-untested]]).
