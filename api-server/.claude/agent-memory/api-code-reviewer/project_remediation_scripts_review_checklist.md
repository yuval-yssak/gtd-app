---
name: remediation-scripts-review-checklist
description: One-off src/scripts/* remediation scripts — loadDataAccess() is not read-only, dry-run defaults are inconsistent, and the DAO+recordOperation write path is the verified no-GCal-write escape hatch
metadata:
  type: project
---

Recurring review findings for manual remediation scripts under `api-server/src/scripts/` (reviewed
`retireOrphanedSeriesSuccessor.ts` 2026-07-27).

**Why:** these scripts run once, by hand, against production data — often to fix damage on a REAL shared
Google Calendar with external attendees. There is no test suite, no staging rehearsal, and no undo. The
failure modes below are invisible from reading the script alone.

**How to apply — demand these on every new `src/scripts/*` review:**

- **`loadDataAccess()` is NOT read-only.** It runs `migrateLegacyClarifyScope`,
  `migrateDeviceSyncStateToPerUserCursor`, `dedupeActiveRoutinesPerGCalSeries`,
  `dedupeCalendarItemsPerEvent` plus four `createIndexes` builds. Any script printing
  "Dry run — nothing written" after calling it is lying. Worse, `dedupeActiveRoutinesPerGCalSeries` can
  flip `active` on the very series the script targets, and `dedupeCalendarItemsPerEvent` can remove rows
  the dry-run just enumerated — so a dry-run preview is not a reliable predictor of the apply run. All
  Mongo-only though: none of it reaches GCal.
- **Dry-run defaults are inconsistent across the directory.** `normalizeRoutineCalendarEventIds.ts` and
  `demoteTrashedCalendarInstanceEventIds.ts` default to preview + require `--apply`;
  `deleteCloneRoutines.ts` and `retireOrphanedSeriesSuccessor.ts` default to DESTRUCTIVE + require
  `--dry-run`. Push for `--apply` opt-in on anything new; muscle memory from the other scripts drops the
  safety flag.
- **Scripts that take a bare entity id must assert identity before mutating.** `findOne({_id})` is
  user-unscoped; one mistyped UUID character silently mutates a stranger's row and fans sync ops to their
  devices. Require a `--user` cross-check flag plus shape assertions (routineType, GCal-linked) — the
  automatic counterparts have many guards, the manual scripts typically have zero.
- **`AbstractDAO.replaceById` upserts** (`{upsert:true}`), so a "retire"/"update" helper called without a
  prior existence check CREATES the entity instead of erroring.

**Verified no-GCal-write path (reusable conclusion):** `DAO writes + recordOperation` WITHOUT
`notifyChange` genuinely cannot reach Google Calendar. `recordOperation` is a bare `operationsDAO.insertOne`;
GCal pushback lives only in `notifyChange`'s fan-out; the DAOs override no write methods; and on the client
`applyEntityOp` writes pulled ops straight to IndexedDB WITHOUT re-queueing into `syncOperations`, so
devices cannot bounce them back through `/sync/push` -> `handleRoutinePush` -> `pushRoutinePause`. That
client rebound path is the non-obvious one — re-verify it if `syncHelpers.ts` ever re-queues on pull.

**Operational gotcha after any GCal-routine retirement:** `healStuckGCalRoutines` matches
`!active || pastUntil` and WILL strip the cap, revive the routine and regenerate its items — undoing the
remediation. `healSplitSuccessorRoutines` will not (it requires an OPEN rrule). Tell the operator not to
press "Repair sync" for that calendar afterward. See [[project_cancelled_master_orphan_sweep]].

Related: [[project_snapshot_replace_defeats_lww_on_concurrent_edits]] (scripts skip the re-fetch that
`deactivateRoutineFromGCal` does), [[project_routine_split_updated_ts_pitfall]].
