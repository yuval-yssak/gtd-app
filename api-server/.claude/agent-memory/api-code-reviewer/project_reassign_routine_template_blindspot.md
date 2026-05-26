---
name: Reference-cascade routine-template blindspot (people/workContext delete)
description: referenceCascades helpers only scan items, never routines. Direct delete of a person/workContext still leaves routine.template.peopleIds[] / template.workContextIds[] dangling. (Reassign no longer hits this — auto-relink fixed it on the reassign path.)
metadata:
  type: project
---

**Scope:** This blindspot now applies ONLY to direct delete of a person/workContext — not to reassign. The reassign flow used to share it, but `relinkRoutineReferences` (added when person/workContext became non-reassignable) now handles routine-template refs correctly.

`referenceCascades.cascadePersonReferenceRemoval` and `cascadeWorkContextReferenceRemoval` `findArray({user, peopleIds | workContextIds})` on `itemsDAO` ONLY. They never scan `routinesDAO`. So when a user trashes a person or workContext:

- `RoutineInterface.template.peopleIds[]` (string array) — still points at the deleted person
- `RoutineInterface.template.workContextIds[]` (string array) — still points at the deleted workContext
- Future routine-generated items inherit the dangling ref via the template copy

**Why this matters:** The routine continues to generate items that reference a person/workContext that no longer exists. The UI's resolver shows a blank label; downstream filters that depend on `peopleIds` collapse silently.

**How to apply:** When reviewing a PR that touches `referenceCascades.ts` or adds a new entity that references people/workContexts:
1. Audit BOTH `cascadePersonReferenceRemoval` / `cascadeWorkContextReferenceRemoval` AND `relinkRoutineReferences` in `lib/reassignEntity.ts` — they must stay in lockstep on which collections carry refs.
2. The reassign path is no longer the right shape to copy — it auto-relinks rather than cascade-strips. The cascade helpers must continue to scan items, and SHOULD be extended to scan routines.
3. `routineExceptions[*].attendees` is a separate GCal-owned identity space; it's not currently in cascade scope and likely shouldn't be.

See [[project_reassign_bypasses_apply_pipeline]] for the reassign contract.
