---
name: unique-index-needs-boot-dedup-migration
description: Adding a NEW unique/partial index to a DAO is unsafe if violating data may already exist in prod/staging — createIndexes rejects and crashes boot. Pair it with a boot dedup migration that runs strictly before the index build.
metadata:
  type: project
---

Building a new unique index inside `DAO.init()` unconditionally will crash startup on the very environment a fix targets, because the bug being fixed implies violating rows already exist (`createIndexes` throws E11000-class on dirty data).

**Why:** First attempt at the `uniq_active_routine_per_gcal_series` routines index (two active routines on same `(user, calendarEventId, calendarIntegrationId)`) put the unique index in `init()` → self-inflicted boot outage in staging where the duplicate data lived. Fix pattern that was accepted: (1) keep only non-unique indexes in `init()`, (2) move the unique build into a separate `ensureUniqueActiveSeriesIndex()` method, (3) add a boot dedup migration (`loaders/routineDuplicateMigration.ts`) that cleans the data, (4) in `mainLoader.loadDataAccess` call dedup-migration AWAIT then index-build AWAIT, strictly ordered, AFTER the DAO-init `Promise.all`.

**How to apply:** On any review that adds a new unique/partial index to an existing collection, require: a paired boot migration proving the data precondition, the index build called only after that migration (grep every caller of the ensure-method — `init` must NOT build it), and a test that inserts violating fixtures then asserts the ensure-method builds without throwing. The keeper-selection tie-break in the dedup must match whatever the read/resolve path uses (here `findExistingRoutineForEvent` → most-recently-updated). Note the residual blue/green gap (see body of [[heal-updated-ts-bump-clobbers-concurrent-edits]] sibling concern): an OLD instance without the index can re-create a violating row in the window between this instance's dedup and its index build — index build can still throw on a rolling deploy. Acceptable as a transient (next boot re-dedups) but flag it.
