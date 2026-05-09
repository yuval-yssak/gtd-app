---
name: Reassign cross-account GCal torn-state residual
description: After the fan-out fix-up pass DB-side torn state is impossible, but moveItemAcrossCalendars still fires GCal create+delete BEFORE preValidateTargetSnapshot, so a matrix-violating snapshot leaves a GCal-only torn state (event on target, deleted from source) with the DB row still intact under fromUserId.
type: project
---

In `api-server/src/lib/reassignEntity.ts:reassignItem`, the order is:
1. `moveItemAcrossCalendars(...)` — GCal `createEvent` on Bob, `deleteEvent` on Alice
2. `persistItemMove(moved.item, ...)` — calls `preValidateTargetSnapshot` BEFORE the source-delete op

If validation fails at step 2, GCal is bidirectionally mutated but DB has not changed. User sees: item still under Alice in app, but Alice's GCal event is gone and Bob has a new event nobody owns in-app.

**Why:** post-review fix-up pass (May 2026) added `preValidateTargetSnapshot` to make DB-side torn state impossible (pinned by `v1Reassign.test.ts:528-560`). It correctly closed the DB hole. The GCal hole pre-existed and was not in scope.

**How to apply:**
- If reviewing changes that touch reassign validation or the `moveItemAcrossCalendars` call site, recommend hoisting `preValidateTargetSnapshot` to fire BEFORE `moveItemAcrossCalendars` so GCal mutation is gated by the same Zod check.
- Don't conflate this with the DB-torn-state-impossible property the post-review pass landed — that one is solid.
- Don't flag during a routine code review as "critical": it requires a matrix-violating row to exist under Alice in the first place, which the strict-mode pipeline now prevents from being written; the residual hole only fires if a legacy row that violates current matrix rules is reassigned.
