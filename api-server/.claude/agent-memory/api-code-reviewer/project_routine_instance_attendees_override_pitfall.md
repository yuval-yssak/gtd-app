---
name: routine-instance-attendees-override-pitfall
description: `pushRoutineInstanceOverride` now forwards `snapshot.attendees` unconditionally; the API has no signal that the UI's detach-warning was shown, so any title/notes/time edit on a routine-instance with inherited attendees silently forks that instance's attendee list.
metadata:
  type: project
---

`provider.updateRecurringInstance` with `attendees` in the patch creates an explicit per-instance attendee override on Google Calendar — once set, that instance is decoupled from future master-attendee changes. Earlier policy stripped attendees from instance pushbacks for exactly that reason; the policy was reversed (May 2026) to support the new "edit attendees on this date" gesture, gated by a MeetingDetails detach-warning dialog client-side.

**Why:** GCal stores per-instance overrides as a delta against the master. A non-null `attendees` field on an instance patch is a hard override that displaces the inherited master list. The new policy forwards `snapshot.attendees` whenever it's defined — but `buildCalendarItem` mirrors the master's attendees onto every generated item, so `snapshot.attendees` is defined for **every routine-instance with master attendees**, not just attendee-membership edits. The "UI guard" lives in the client only; the API path can't tell whether the dialog was shown.

**How to apply:**
- Net effect of the policy flip: any title/notes/time edit on a routine-instance whose master has attendees now silently forks that instance. The fork is permanent — future master-attendee adds won't reach forked instances.
- On review: flag any new `pushRoutineInstance*` caller that forwards `snapshot.attendees` without a per-key diff against the routine master. The safer pattern is: forward attendees ONLY when `snapshot.attendees` differs (by membership or responseStatus) from `routine.attendees`.
- RSVP route (`POST /calendar/items/:itemId/rsvp`) hits `patchEventAttendees` with `item.calendarInstanceEventId` when the item is a routine-instance. This explicitly forks the instance for the RSVPer's own response — which is semantically correct ("my Monday RSVP isn't my Tuesday RSVP") but adds another instance-fork path. Demand tests for routine-instance RSVP flow before approval.
- Tests covering routine-instance push must assert that an inherited-attendees-only snapshot does NOT push attendees to GCal, but a divergent snapshot does. The current single test only covers the divergent case.
- This memory replaces an earlier one that said "demand removal of attendees on routine-instance pushback" — that policy is gone. The risk persists; the gate moved.
