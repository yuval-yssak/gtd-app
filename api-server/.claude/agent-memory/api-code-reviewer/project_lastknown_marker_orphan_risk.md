---
name: lastknown-marker-orphan-risk
description: RESOLVED on fix/gcal-relink-sweep — active sweep now clears same-account markers directly (getEvent by id) after every full sync; cross-account deliberately left unlinked. Memo kept as review checklist for the skip-flag invariant.
metadata:
  type: project
---

`lastKnownCalendarEventId` is a load-bearing skip flag in `calendarPushback.ts` (handleItemPush, pushItemToGCalWithContext, handleRoutinePush, pushRoutineToGCalWithContext). The skip is unconditional — there is no expiry, no fallback to plain push, and the only way the marker gets cleared is `tryRestoreFromLastKnownEventId` matching an inbound GCal event with the same id.

**Why:** Avoids minting a duplicate event whose id would collide with the original on reconnect. Correct for same-account reconnect; broken for cross-account reconnect (a brand-new GCal account will never echo back the old event id).

**How to apply:** On any review touching the disconnect/reconnect path or the `lastKnown*` skip, demand either (a) a repair pass on reconnect that clears `lastKnown*` for items whose `lastKnownCalendarIntegrationId` no longer matches a live integration, or (b) an explicit acknowledgement in code + test that cross-account reconnect leaves these items orphaned. Backfill/Sync-now currently picks them up (query is `calendarEventId: {$exists: false}`) but the push skip silently swallows them.

**Resolution (fix/gcal-relink-sweep):** `relinkStrandedMarkers` in calendar.ts runs after every full sync + via POST /maintenance/relink-calendar-markers. For same-account markers it fetches the event directly by id (`getEvent`, 404/410→null), then converges via content-anchored LWW (content-diff + lastPushed/lastSynced anchors, not updatedTs which disconnect pollutes). Cross-account markers are now left FULLY intact (leave-unlinked decision) — the old wipe-and-repush path was removed, and the inbound strong-key restores are scoped by `markerOriginAccountScope` (origin email match, or legacy email-less) so a same-id event on a new account can't hijack them. Legacy email-less markers are relink-only best-effort (provenance unproven → no destructive gone-event action).

Related: [[calendar-restore-ordering-pitfall]] — the restore call site that clears these markers must be gated on cancelled/past/!rrule short-circuits to avoid restore-then-trash double ops.
