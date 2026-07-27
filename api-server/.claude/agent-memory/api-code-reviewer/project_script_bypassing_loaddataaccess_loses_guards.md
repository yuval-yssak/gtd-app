---
name: script-bypassing-loaddataaccess-loses-guards
description: Scripts that connect directly to skip boot migrations also silently lose env validation and unique-index builds — check both whenever loadDataAccess is bypassed.
metadata:
  type: project
---

When a one-off script replaces `loadDataAccess()` with a direct `MongoClient` connect (a legitimate fix
for "migrations run before the dry-run gate"), it silently drops TWO guards beyond the migrations it
meant to skip:

1. **Env validation.** `mongoDBConfig` defaults both `DBUrl` and `dbName` to `''`. An empty dbName does
   NOT throw — `client.db('')` resolves to the connection string's default database, so the script
   mutates a DB the operator never named. Demand the `auditSyncOps.ts`-style explicit check.
2. **Unique-index builds.** `ensureUniqueActiveSeriesIndex` / `ensureUniqueCalendarEventIndex` are called
   from the boot path only. Scripts whose safety argument leans on "at most one active routine per
   series" lose that guarantee on a scratch/restored DB. Correct fix is ASSERT the index exists, not
   build it — building can crash on violating data, which is the original reason for skipping migrations.

**Why:** surfaced reviewing `scripts/retireOrphanedSeriesSuccessor.ts`. The `connectWithoutMigrations`
refactor was the right call (better than adding `skipMigrations` to shared production boot code), but
it traded a loud failure for a silent wrong-database write.

**How to apply:** whenever a script imports DAOs but NOT `loadDataAccess`, check for both guards before
approving. Also verify which DAOs are initialized covers the transitive closure — `recordOperation`
reaches only `operationsDAO.insertOne` (no notifyChange / webhook / GCal fan-out), so a
DAO+recordOperation-sans-notifyChange script is genuinely GCal-safe. See
[[project_remediation_scripts_review_checklist]] and [[project_cancelled_master_orphan_sweep]].
