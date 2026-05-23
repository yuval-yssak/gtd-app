---
name: lastknown-marker-orphan-risk
description: Items/routines carrying lastKnownCalendarEventId from a disconnect-with-keep become permanently un-pushable if the user reconnects to a different GCal account. The pushback skip is unconditional; only a matching inbound event clears the marker.
metadata:
  type: project
---

`lastKnownCalendarEventId` is a load-bearing skip flag in `calendarPushback.ts` (handleItemPush, pushItemToGCalWithContext, handleRoutinePush, pushRoutineToGCalWithContext). The skip is unconditional — there is no expiry, no fallback to plain push, and the only way the marker gets cleared is `tryRestoreFromLastKnownEventId` matching an inbound GCal event with the same id.

**Why:** Avoids minting a duplicate event whose id would collide with the original on reconnect. Correct for same-account reconnect; broken for cross-account reconnect (a brand-new GCal account will never echo back the old event id).

**How to apply:** On any review touching the disconnect/reconnect path or the `lastKnown*` skip, demand either (a) a repair pass on reconnect that clears `lastKnown*` for items whose `lastKnownCalendarIntegrationId` no longer matches a live integration, or (b) an explicit acknowledgement in code + test that cross-account reconnect leaves these items orphaned. Backfill/Sync-now currently picks them up (query is `calendarEventId: {$exists: false}`) but the push skip silently swallows them.

Related: [[calendar-restore-ordering-pitfall]] — the restore call site that clears these markers must be gated on cancelled/past/!rrule short-circuits to avoid restore-then-trash double ops.
