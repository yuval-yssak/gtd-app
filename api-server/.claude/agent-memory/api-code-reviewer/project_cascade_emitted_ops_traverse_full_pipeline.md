---
name: cascade-emitted-ops-traverse-full-pipeline
description: Reference cascades (person/workContext delete) emit item-update ops through applyAndPublishOperations, which means cascade-driven snapshot mutations fan out to GCal/SSE/web push/webhooks. Easy to forget to suppress GCal pushback for "internal" cascades.
metadata:
  type: project
---

When a cascade-style helper (e.g. `cascadePersonReferenceRemoval`, `cascadeWorkContextReferenceRemoval`, anything that strips dangling refs after a delete) goes through `applyAndPublishOperations`, every emitted op is treated exactly like a normal client write — full SSE + web push + GCal pushback + webhook fan-out.

For breadcrumb-style cascades that mutate `title`, this means the appended `[person removed: Jane]` tag gets pushed to the user's Google Calendar event title via `pushExistingItemToGCal`, and for routine-generated instances goes through `pushRoutineInstanceOverride` (which also forks the instance off the master — see [[project_routine_instance_attendees_override_pitfall]]).

**Why:** `notifyChange` / `notifyChanges` is the single fan-out. There is no "this op is server-internal" flag short of `suppressGCalPushback: true` on `ApplyOptions`. Cascades that should remain GTD-local need to opt in.

**How to apply:** On any review of a new cascade or background process that emits ops through `applyAndPublishOperation(s)`, look for:
  1. Does the cascade mutate a field that the GCal pushback chain would forward? (`title`, `timeStart`, `timeEnd`, `notes`, `attendees`, `status`, `allDay`)
  2. Is the affected entity calendar-linked (`status: 'calendar'` + `calendarEventId`) or a routine instance (`routineId` + `timeStart`)?
  3. If yes to both, demand `suppressGCalPushback: true` in the cascade's `ApplyOptions`, plus a regression test asserting `provider.updateEvent` / `provider.updateRecurringInstance` is NOT called.

Related: routine-instance overrides also fork attendees per [[project_routine_instance_attendees_override_pitfall]]; this concern compounds when the cascade title-edit lands on a routine instance.
