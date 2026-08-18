---
name: master-linked-standalone-item-convergence
description: A standalone item can hold calendarEventId = a routine's MASTER recurring event; the absorb + pushback-reroute fix has two soft spots — routine resolution must be active-scoped, and the rerouted snapshot's attendees are frozen/stale by construction
metadata:
  type: project
---

**The bug class:** a GCal event synced as a one-off item *before* its `recurrence` was visible keeps
`calendarEventId` = the series MASTER. `handleItemPush` routes any item with a `calendarEventId` to
`pushExistingItemToGCal`, whose done branch PATCHes `applyDoneMarker` + `DONE_COLOR_ID` onto that id —
marking **every occurrence** done for all attendees. The trash branch would `deleteEvent` the whole series.

**Why:** observed on staging 2026-08-18. The ✓ then round-tripped inbound into the routine's and open
items' stored titles, so the damage was self-propagating.

**RESOLVED 2026-08-18.** Both soft spots below were caught in review and fixed before merge; the notes
stay as the review checklist for the next diff in this area.

1. **Guard-match scope and reroute-target scope are two DIFFERENT questions — don't collapse them.**
   `uniq_active_routine_per_gcal_series` is partial on `active: true`, so a **split series legitimately
   has multiple routines on the same bare `calendarEventId`** (capped base + live successor). A bare
   `routinesDAO.findOne({user, calendarEventId})` has no ordering and can return the dead capped base.
   The accepted shape splits it: `findRoutinesOnMasterEvent` returns ALL matches and **any** match arms
   the guard (so the master is protected even when only retired routines remain), while a separate
   `pickLiveRerouteTarget` filters to `active`, prefers the item's own integration, then latest
   `updatedTs`. No active routine ⇒ skip the push rather than reroute onto a capped base (its
   instance-window lookup would silently drop it anyway). Cross-link
   [[gcal-resplit-rekey-and-fault-isolation]].

2. **Rerouting into `pushRoutineInstanceOverride` carries a stale attendee list.** The standalone
   duplicate got its `attendees` from `pickGCalOwnedFields(event)` at import time and is then **frozen**:
   once a routine owns the master id, master re-reports route to the routine path, so
   `updateExistingCalendarItem` never refreshes that item again. Meanwhile `routine.attendees` keeps
   updating. `attendeesDiverge = !attendeesEqual(routine.attendees, snapshot.attendees)` compares
   `responseStatus` too, so **a single attendee RSVP makes them diverge** — and a divergent list on
   `updateRecurringInstance` is an RFC-5545 per-instance override that permanently forks that occurrence
   from the master. Fix: strip the snapshot's attendees and mirror the TARGET routine's list, so the
   gate reads "identical to master" and forwards no `attendees` key. See
   [[routine-instance-attendees-override-pitfall]].

**Deliberate asymmetry worth preserving:** `removeItemGCalPresence` skips on ANY match (not
active-scoped). If only a capped base holds the id, the GCal master still exists and holds past
occurrences for all attendees — active-scoping there would let `deleteEvent` wipe the series. Series
deletion is owned by `pushRoutineDeletion` (`deleteRecurringEvent`, keyed off the routine entity);
both `removeItemGCalPresence` call sites are item-scoped (hard-delete, calendar→active detach), so an
item path should never be able to remove a series.

**Also verify on any diff in this area:** the absorb query is integration-scoped while the pushback
guard is user-scoped. That's deliberate, but it means a row whose `calendarIntegrationId` went stale
after a disconnect/reconnect is guarded forever and never healed. Worth a test pinning the behaviour.
