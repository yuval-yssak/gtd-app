---
name: /v1/reassign now uses applyAndPublishOperation pipeline
description: reassignEntity routes both legs of every entity move through applyAndPublishOperation in strict mode. People/workContexts are not directly reassignable — moved items/routines auto-relink refs into the recipient. SSE/web push/webhooks/GCal pushback fire on every leg.
metadata:
  type: project
---

`/v1/reassign` and `/sync/reassign` are thin wrappers around `lib/reassignEntity.ts`. The helper:

- Rejects `entityType: 'person' | 'workContext'` at the dispatcher with `status:400, code:'validation_failed'`. The public-API body parser rejects earlier with `code:'invalid_entityType'`.
- For item/routine moves: routes BOTH source-delete and target-create through `applyAndPublishOperation` (strict mode). `preValidateTargetSnapshot` runs the same Zod check ahead of the source delete so a torn snapshot can't produce a torn state.
- Auto-relinks `peopleIds` / `workContextIds` / `waitingForPersonId` (items) and `template.peopleIds` / `template.workContextIds` (routines) into the recipient's account via find-or-create. Match policy: person email-first then name, workContext exact name. Source-user persons/contexts are NEVER mutated.
- `deviceId` plumbed through: `/v1/reassign` passes `api:<tokenId>`, `/sync/reassign` defaults to `'server'`.
- `suppressGCalPushback: true` on both legs of calendar-item moves because `moveItemAcrossCalendars` already drove the GCal create + delete inline. Routine reassign does NOT pass it — the routine cascade in `pushRoutineDeletion` is the desired source-side cleanup.
- `suppressReferenceCascade: true` on the source-delete leg of item moves (the cascade would clobber sibling rows on the source).

**Why the rejection branch matters:** the old "move the entity, surface dangling refs in `crossUserReferences`" gesture pushed the relink burden onto the caller. The new model inverts it — auto-relink is server-side, so the caller never needs to interpret `crossUserReferences` (which is now effectively dead surface area on item/routine moves too).

**Known landmines (flag on any reassign PR):**
1. **Mirror create runs BEFORE pre-validation.** `relinkItemReferences` calls `applyAndPublishOperation` for each missing mirror. If a downstream precondition (`targetCalendar` missing, snapshot validation, GCal create-on-target fails) then aborts the move, the mirror persons/contexts orphan under toUserId. Fix is to move preconditions ahead of the relink. See [[project_reassign_mirror_orphan_on_failure]].
2. **`Promise.all` over relink races mirror-create.** Two ids in the same `peopleIds` array that share an email/name (or are duplicates of each other) each find no target match in parallel, then each create a fresh mirror. No unique index backstops it. Fix is sequential iteration + per-match-key dedup. See [[project_reassign_promise_all_mirror_race]].
3. **Dead `sourcePerson.user === toUserId` branch** in `relinkPersonId`/`relinkWorkContextId`: unreachable because `findByOwnerAndId(id, fromUserId)` already filters. Misleads readers about target-owned id handling.
