---
name: /v1/reassign now uses applyAndPublishOperation pipeline
description: reassignEntity has been migrated to applyAndPublishOperation for both legs of every entityType. SSE/web push/webhooks/GCal pushback now DO fire on reassign. Reference cascade is the one knob that must be suppressed on the source-leg delete.
type: project
---

`/v1/reassign` and `/sync/reassign` are thin wrappers around `lib/reassignEntity.ts`. The helper now routes BOTH the source-delete and target-create legs of every entity move through `applyAndPublishOperation` (in strict mode). Consequences for any reassign op as of the cascade-suppression fix (May 2026):

- ✅ `notifyChange` fan-out fires on both legs — SSE, web push, webhook deliveries, GCal pushback all happen on each user channel.
- ✅ Zod validation runs on the create-leg snapshot (via `preValidateTargetSnapshot` BEFORE the source delete fires, so a torn move is impossible).
- ✅ `deviceId` is plumbed through — `/v1/reassign` passes `api:<tokenId>`, `/sync/reassign` defaults to `'server'`.
- **NEW knob**: `suppressReferenceCascade: true` must be passed on the source-delete leg for `person` and `workContext` entity types — otherwise the cascade strips the reassigned id from every referencing item under fromUser and appends a `[person removed: …]` breadcrumb. The reassign contract surfaces cross-user refs via `crossUserReferences` instead.
- `suppressGCalPushback: true` is passed on both legs of calendar-item moves because `moveItemAcrossCalendars` already drove the GCal create + delete inline. Routine reassign does NOT pass it — the routine cascade in `pushRoutineDeletion` is the desired source-side cleanup.

**Why this fix:** A previous cascade-leakage bug stripped peopleIds/workContextIds from items in fromUser's account on reassign, then appended audit-corrupting breadcrumbs. The reassign helper's own `findItemsReferencing*` already produces the correct `crossUserReferences` payload — the cascade was redundant and destructive.

**How to apply:** When reviewing reassign-touching PRs:
1. Any NEW use of `suppressReferenceCascade` outside `persistSimpleEntityMove` source-leg is suspect — flag it.
2. If a new entity type is added (beyond item / routine / person / workContext), check whether its delete-leg cascade needs the same suppression.
3. `findItemsReferencingPerson` covers `peopleIds[]` AND `waitingForPersonId`; `findItemsReferencingWorkContext` covers only `workContextIds[]`. Adding a new person/workContext reference shape on items requires updating these helpers — see [[project_reassign_routine_template_blindspot]] for known limits.
4. Reference cascade scans ONLY `items` — `routine.template.peopleIds[]`, `routine.template.workContextIds[]`, and routine-exception attendees are pre-existing blind spots (no cascade, no crossUserReferences entry).
