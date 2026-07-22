---
name: reassign-seeds-target-routine-items
description: Cross-account routine reassign now seeds target items server-side; RoutineItemGenerationContext keys on deviceId not tokenId
metadata:
  type: project
---

Cross-account routine reassign (`lib/reassignEntity.ts`) now seeds the new owner's items via `seedTargetRoutineItems` after `persistRoutineMove` (nextAction → `ensureFirstRoutineItem`; calendar → `regenerateFutureRoutineItems` + `notifyChanges({suppressGCalPushback:true})`), wrapped so a seed failure never tears the committed move.

**Why:** the SSE per-user pull path never runs the client `materializePendingNextActionRoutines` backstop, and calendar routines have no client backstop at all → moved routine sat itemless until app reload.

**How to apply:**
- `RoutineItemGenerationContext` now carries `deviceId` (full stamp) NOT `tokenId`. Public-API callers pass `api:<tokenId>`; the reassign orchestrator passes `params.deviceId ?? 'server'`. On review, verify NEW callers pass a full deviceId, not a bare tokenId.
- Seed op `deviceId` is the behavior this refactor changed but tests DON'T assert it — demand `deviceId` assertion on the recorded seed op (`server` for in-app /sync path, `api:<tokenId>` for /v1). Item-existence alone is non-discriminating.
- Calendar seed leg records ops with default `'server'` (doesn't thread `params.deviceId`); nextAction leg threads it. Minor provenance asymmetry, harmless (no target device to echo-suppress cross-account).
- Related: [[project_reassign_bypasses_apply_pipeline]], [[project_regen_done_unmask_test_nondiscriminating]].
