---
name: Reassign mirror persons/contexts orphan on downstream failure
description: relinkItemReferences / relinkRoutineReferences call applyAndPublishOperation BEFORE preValidateTargetSnapshot, the targetCalendar precondition check, and moveItemAcrossCalendars. Any post-relink failure leaves committed mirror rows + ops + fan-out under toUserId with no rollback.
metadata:
  type: project
---

In `lib/reassignEntity.ts`, the orchestrator runs the relink (`relinkItemReferences` / `relinkRoutineReferences`) ahead of the gates that determine whether the move can succeed:

- `reassignItem`: relink → targetCalendar required-check → `moveItemAcrossCalendars` (GCal create/delete) → `persistItemMove` → `preValidateTargetSnapshot`
- `persistRoutineMove`: relink → `preValidateTargetSnapshot` → applyAndPublishOperation

Each mirror person/workContext created via `applyAndPublishOperation` is fully committed: collection row + operations log entry + SSE + web push + webhook fan-out. There is no compensating delete on failure.

**Concrete orphan scenarios:**
1. Calendar-linked item without `targetCalendar` in request → 400 returned, but mirrors already created.
2. Strict-mode snapshot validation rejects the move → 400 `validation_failed`, but mirrors created.
3. `moveItemAcrossCalendars` returns 502 (GCal create-on-target failed) → mirrors created. WORST CASE: this happens between GCal create-on-target succeeding and a later `preValidateTargetSnapshot` failure — leaves mirrors + GCal event on target + GCal event deleted from source + no item on target.

**Why this matters:** The `preValidateTargetSnapshot` comment block (line 411-417) literally promises "Without this guard a malformed snapshot would land us in a torn state." The relink violates that promise by placing irreversible side-effects before the gate.

**How to apply:** When reviewing reassign PRs:
1. Move all cheap fast-fail preconditions (targetCalendar check, shape-only pre-validation) ahead of any relink.
2. For paths that can't be reordered (GCal create-on-target), demand at least a comment acknowledging the orphan risk and a recovery story for the operator (script that prunes orphan persons/contexts whose `createdTs > anchorTs AND no item references them`).
3. Demand a regression test: reassign with `peopleIds:[sourceP]` AND a snapshot that fails validation; assert `bob.people.length === 0`.

See [[project_reassign_bypasses_apply_pipeline]] for the surrounding contract and [[project_reassign_promise_all_mirror_race]] for the parallel-race counterpart.
