---
name: routine-type-switch-marker-shedding-asymmetry
description: PATCH /v1/routines sheds lastKnownCalendar* on type-switch; the reassign path (persistRoutineMove) does not — recurring "clear-on-switch missed a surface" pattern
metadata:
  type: project
---

Type-switch clear-on-switch fixes tend to land on the PATCH surface but miss the reassign surface (and vice-versa). This is the same class as [[project_routine_type_switch_stale_field_reject]] (recurrenceAnchor / GCAL_OWNED_ROUTINE_KEYS).

Concrete instance found 2026-07-11: PATCH /v1/routines clears `lastKnownCalendarEventId/IntegrationId/SyncConfigId/AccountEmail` on `wantsTypeSwitch` (flip-back-churn guard), but `reassignEntity.persistRoutineMove` strips only the live `calendarEventId/IntegrationId/SyncConfigId` (+ GCAL_OWNED via applyRoutineEditPatch) — NOT the `lastKnown*` markers. Harm is neutralized in practice by the new `restoreRoutineCalendarLink` `routineType !== 'calendar'` guard, but the markers also reference the SOURCE user's integration ids, so they're meaningless under the recipient regardless.

**Why:** spread-inheritance (`next = {...routine}`) carries every stale field forward; each type-switch surface must explicitly delete calendar-only fields or the target-side create 400s / relinks wrongly.

**How to apply:** on ANY routine type-switch field-shedding change, grep for every merge-over-existing surface (PATCH /v1/routines, reassign applyRoutineEditPatch/persistRoutineMove, split buildTail is safe—whitelist-build) and confirm the same clear is applied to all of them. Cross-check GCAL_OWNED_ROUTINE_KEYS, recurrenceAnchor, AND lastKnown* markers together.
