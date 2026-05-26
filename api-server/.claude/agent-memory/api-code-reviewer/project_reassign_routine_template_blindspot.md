---
name: Reassign crossUserReferences blind spot — routine templates
description: findItemsReferencingPerson/WorkContext only scan the items collection; routine.template.peopleIds[] and template.workContextIds[] are never surfaced in crossUserReferences and never cascade-stripped. Same blind spot for routineExceptions[].attendees.
type: project
---

`reassignEntity.findItemsReferencingPerson` and `findItemsReferencingWorkContext` scan ONLY the `items` collection. When a person or workContext is reassigned across users, references that live on a routine document under the source user are silently ignored:

- `RoutineInterface.template.peopleIds[]` (string array)
- `RoutineInterface.template.workContextIds[]` (string array)
- `RoutineInterface.attendees[]` / `routineExceptions[*].attendees[]` — GCal-owned attendees, may carry person-like emails (different identity space than `peopleIds`, but conceptually related)

`referenceCascades.cascadePersonReferenceRemoval` and `cascadeWorkContextReferenceRemoval` have the same scope limit — they only `findArray({user, peopleIds | workContextIds})` on `itemsDAO`, never on `routinesDAO`. So a true delete of a person/workContext ALSO leaves these routine refs dangling. Pre-existing, not introduced by the reassign fix.

**Why this matters:** A reassign caller can read `crossUserReferences.peopleIds` and decide how to handle them in UI (e.g. confirm dialog or auto-strip). For routine refs, they get no signal at all — the routine continues to generate items under the new owner that still carry the old person id, which now points into a different user's account.

**How to apply:** If a PR widens reference-cascade coverage to routines, OR adds a new entity that references people/workContexts, audit BOTH:
1. `findItemsReferencingPerson` / `findItemsReferencingWorkContext` in `reassignEntity.ts`
2. `cascadePersonReferenceRemoval` / `cascadeWorkContextReferenceRemoval` in `referenceCascades.ts`

These two helper sets must remain in lockstep — drift is the bug. See [[project_reassign_bypasses_apply_pipeline]] for the surrounding contract.
