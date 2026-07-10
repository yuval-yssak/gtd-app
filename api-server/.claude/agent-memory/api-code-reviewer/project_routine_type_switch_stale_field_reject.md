---
name: routine-type-switch-stale-field-reject
description: nextAction-only routine fields left stale when routineType switches to calendar via merge-over-existing paths (PATCH /v1/routines, reassign applyRoutineEditPatch) trip RoutineSnapshotSchema.superRefine → 400
metadata:
  type: project
---

Any routine field gated "nextAction-only" by a `RoutineSnapshotSchema.superRefine` reject (e.g. `recurrenceAnchor`, added 2026-07-11) is a landmine on the two **merge-over-existing** write paths:

- **PATCH `/v1/routines/:id`** — `snapshot = { ...existing, ...raw }`. If `existing` carries the nextAction-only field and `raw` sets `routineType:'calendar'` without clearing it, the merged snapshot fails superRefine → 400. Caller has no clean way to send a clearing value through WRITABLE_FIELDS.
- **reassign `applyRoutineEditPatch`** — `next = { ...routine }`; switching type via patch leaves the inherited field, then `preValidateTargetSnapshot`/strict create reject.

**Why:** these paths carry-forward via spread; the new field's guard only checks whether to *apply* the incoming patch value (`next.routineType === 'nextAction'`), never whether to *strip* an already-present value when the type flips away from nextAction.

**Contrast — safe path:** `buildTail` (split composite) whitelist-BUILDS the tail field-by-field, so a calendar tail simply omits the field. No asymmetry there.

**How to apply:** whenever a superRefine adds a `routineType`-conditional field, demand that BOTH merge-over-existing paths clear the field when the resulting type no longer permits it (e.g. `if (next.routineType !== 'nextAction') delete next.recurrenceAnchor`). Demand a regression test: existing nextAction routine WITH the field, PATCH/reassign switching to calendar, assert success (not 400). Same shape as [[project_v1_patch_trash_extra_drift]] merge-drift class.
