---
name: routine-instance-attendees-override-pitfall
description: Forwarding `attendees` on `updateRecurringInstance` silently locks instance attendees to a stale master snapshot — instance overrides displace, not inherit.
metadata:
  type: project
---

`provider.updateRecurringInstance` with `attendees` in the patch creates an explicit per-instance attendee override on Google Calendar. It does NOT round-trip as "echo the master's list" — once set, that instance is decoupled from future master-attendee changes.

**Why:** GCal stores per-instance overrides as a delta against the master. A non-null `attendees` field on an instance patch is a hard override that displaces the inherited master list. Routine-generated items snapshot the master's attendees from inbound-parse echoes, so pushing them back appears idempotent at write time but freezes the attendee list at that moment for that one instance.

**How to apply:** On any review where `pushRoutineInstanceOverride` (or any helper feeding `updateRecurringInstance`) spreads `snapshot.attendees`, demand its removal. Attendees on routine-instance overrides should be omitted entirely — the master's list applies. Single-event (`updateEvent`) and create paths are fine to forward attendees. Tests covering routine-instance push must assert the patch requestBody has no `attendees` key.
