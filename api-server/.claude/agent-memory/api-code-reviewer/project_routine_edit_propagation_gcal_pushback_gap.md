---
name: routine-edit-propagation-gcal-pushback-gap
description: propagateCalendarRoutineEdit fans regen ops through notifyChanges with NO suppressGCalPushback — for GCal-LINKED routines this double-pushes (master rrule via routine op + per-instance overrides/cancellations), the exact churn/fork class. All tests use in-app routines where the leg silently no-ops.
metadata:
  type: project
---

`propagateRoutineEditToItems` (src/lib/routineEditPropagation.ts, PATCH /v1/routines Phase 3) calls `notifyChanges(ops)` on the calendar-path regen ops with NO `suppressGCalPushback`.

**Why this is a bug for GCal-linked routines:** on a schedule PATCH the routine snapshot op already goes through `handleRoutinePush` → `pushExistingRoutineToGCal`, updating the whole master series' rrule/timing. Then each regen op (trash → `pushRoutineInstanceCancellation`, create status:'calendar'+routineId → `pushRoutineInstanceOverride`) pushes a per-instance mutation on that same freshly-updated master. That forks individual instances and cancels others against the new master — the self-referential churn / duplicate-instance class the memory files repeatedly document ([[project_cascade_emitted_ops_traverse_full_pipeline]], [[project_routine_instance_attendees_override_pitfall]], [[project_gcal_self_referential_split_churn_fix]]).

**The precedent it violates:** the GCal INBOUND path (calendar.ts) that also runs `regenerateFutureRoutineItems` publishes via `notifyDevicesOfSyncOps` — SSE + web push ONLY, no GCal pushback — precisely because those changes came from GCal. The PATCH path's changes did NOT come from GCal, so the master push is wanted but the per-instance re-push on top of it is not.

**How to apply:** For any new caller of the regen helpers (`regenerateFutureRoutineItems`, `propagateRoutineContentToItems`, `propagateRoutineTitleToItems`) that fans out via `notifyChanges`/`notifyChange`, ask: is the routine GCal-linked (`routine.calendarEventId` set)? If the routine-level op already pushes the schedule to the master, the per-instance regen ops must use `suppressGCalPushback: true` (or the SSE+push-only `notifyDevicesOfSyncOps`-style fan-out). Demand a GCal-LINKED-routine test with a mocked provider asserting `updateRecurringInstance` / `cancelRecurringInstance` is NOT called for the schedule-edit regen. Note: ALL current v1RoutineEditPropagation.test.ts cases seed routines with no `calendarEventId`, so `pushRoutineInstance*` returns early at the `!routine.calendarEventId` guard and the gap is completely masked.
