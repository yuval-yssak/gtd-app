---
name: routine-delete-nextaction-cascade
description: pushRoutineDeletion cascades to BOTH calendar items (trashGeneratedCalendarItems) and open nextAction items (trashGeneratedOpenNextActionItems). The two cascades are disjoint by status and use direct updateMany + recordOperation (op-log only), NOT applyAndPublishOperations.
metadata:
  type: project
---

`pushRoutineDeletion` (calendarPushback.ts) trashes a deleted routine's generated items via two sibling helpers, kept deliberately disjoint by status:
- `trashGeneratedCalendarItems` — `status:'calendar'`, also `$unset calendarInstanceEventId` (frees the presence-partial unique index for GCal re-import).
- `trashGeneratedOpenNextActionItems` — `status: {$nin:['done','trash','calendar']}`, no date filter (delete has no "finish the backlog" nuance, unlike pause's `trashFutureOpenItemsForRoutine`).

**Why the direct updateMany + recordOperation (not applyAndPublishOperations):** these are the intended clobber — "delete the routine" wins over any concurrent in-flight edit, so there is deliberately NO LWW guard. Because they don't go through the apply pipeline, they do NOT trigger GCal/SSE re-push per item (only the op log entry for sync-pull convergence). That's correct: the calendar items' GCal events are torn down once by the master `deleteRecurringEvent`, and nextAction items were never on GCal. So [[project_cascade_emitted_ops_traverse_full_pipeline]] does NOT apply here.

**Residual (non-blocking) race:** there is a read(`findArray`)→write(`updateMany`) window. A client edit landing in that window is overwritten in the DB by `updateMany` (fine — delete wins), but the op-log snapshot is built from the stale pre-read `item` (`{...item, status:'trash'}`), so the recorded snapshot may miss a concurrent field edit. Low impact because the item is being trashed anyway. Same shape as the sibling `trashGeneratedCalendarItems`, so pre-existing convention. Distinct from [[project_snapshot_replace_defeats_lww_on_concurrent_edits]] because there's no replaceById-with-fresh-updatedTs replay.

**No routineId index** on the `items` collection — both cascades' `{user, routineId, status}` queries ride the `user+status` index prefix then filter. Pre-existing; acceptable at per-user cardinality.
