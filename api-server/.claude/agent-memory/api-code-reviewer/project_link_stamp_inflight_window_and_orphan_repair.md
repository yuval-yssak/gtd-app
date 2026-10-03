---
name: project-link-stamp-inflight-window-and-orphan-repair
description: Calendar-link carry-forward (2026-10) leaves an in-flight window before the link stamp, and the orphaned-done repair runs AFTER the full-sync import so it can double-link an event
metadata:
  type: project
---

The calendar-link carry-forward fix (branch fix/calendar-link-carry-forward, reviewed 2026-10-03) only protects edits made
AFTER `stampItemCalendarLink` landed. Two residual holes to re-check on any follow-up:

1. **In-flight window**: a done/edit op applied while `events.insert` is still running hits
   `handleItemPush` with no `calendarEventId` (done → no branch; calendar edit → `gcalCreationInFlight`
   'skipped'). The stamp then `$set`s `lastPushedToGCalTs = updatedTs = now`, so `isMissedPush` is false
   and nothing ever re-pushes the done marker or the edit. Fix shape: after the stamp, compare the stamped row
   against the pushed snapshot (status/content or pre-stamp updatedTs) and re-run `handleItemPush`.
2. **Orphan repair vs import**: `relinkOrphanedDoneItems` runs inside `relinkStrandedMarkers`, i.e. after
   `importCalendarEvents` on a full (410) sync. If the done row carries `calendarIntegrationId`, the naked relink
   (needs integration absent) misses, `createNewCalendarItem` imports a duplicate, then the repair links the done row
   to the same event too. `findCalendarItemByEventId` is status-unfiltered → inbound becomes ambiguous.

Also: a relinked orphan whose ✓ push fails is never retried: it has no `lastPushedToGCalTs`/`lastSyncedFromGCalTs`,
so `isMissedPush` returns false (anchor undefined) and the outcome is discarded.

Round 2 (2026-10-03): (1) fixed via `pushStateReachedDuringCreate` + `withFollowUp` (follow-up failure fails the
create op; Retry re-enters via already-linked). (2) fixed: repair now runs before import + skips if another row owns the id.
New round-2 finding: the repair is called from `syncSingleCalendar` (per CONFIG) but probes ALL configs, and on a
first connect/reconnect the integration `_id` is brand new so every deterministic probe is a guaranteed miss —
candidates x configs^2 getEvent + 150 ms pacing on the connect request. Ask for `updatedTs >= integration.createdTs`
and probe only the syncing config. Also: `followUpOp` is ignored by the backfill/recreate callers (they read
`recordedOp` only), and `mapOpToEvents` emits `item.completed` for ANY update op on a done row, so server ops on
done rows (link stamp, relink) can duplicate webhook deliveries.

Round 3 (2026-10-03): R1 FIXED (createdTs floor + per-config probe), followUpOp now routed via exported `recordedOpsOf`; APPROVED. Remaining documented gap: hard delete during create orphans the event.

**Why:** These are the same silent-no-✓ symptom as the original incident, through other doors.
**How to apply:** On any change to the link stamp or the relink sweep, ask for a test that does done-before-stamp and
a full-sync test whose listEventsFull returns the orphan's deterministic event. See [[gcal-pushback-failure-surfacing-coverage]].
