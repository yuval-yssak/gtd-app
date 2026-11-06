---
name: linked-routine-bulk-item-ops
description: Client bulk item update/delete ops for a GCal-linked routine each fire a per-instance Google override or cancellation; the server suppresses these for its own regen.
metadata:
  type: feedback
---

On a Google-linked routine, every client-queued item `update` op runs `pushRoutineInstanceOverride` on the server, and every `delete` op runs `pushRoutineInstanceCancellation`. That is one Google call per item, and each override forks that instance off the master. The server's own regen fans out with `suppressGCalPushback: true` for exactly this reason (routineEditPropagation.ts). Client ops have no way to suppress pushback. `isPastSeriesEnd` only gates UNTIL/COUNT tails.

**Why:** the 2026-11-06 production incident (a schedule edit deleted 166 items, causing a cancellation storm) came from this. The reconcile fix still queued one update per item on a time change.

**How to apply:** for any client change that bulk-updates or bulk-deletes routine items, ask: is the routine linked? How many Google calls does that make? Does it fork instances or leave a stale `calendarInstanceEventId`? (Instance ids encode the original start time, and the server carry-forward re-adds any id the client strips.) Related: [[gcal-exception-without-itemid]].

Two traps that showed up in the follow-up fix (same branch, re-review on 2026-11-06):
- **A server-side field rewrite with no op gets undone.** If the server rewrites `calendarInstanceEventId` without recording an op, the next client snapshot puts the old value back. The client holds and resends the field, and `carryForwardCalendarLink` only fills fields the incoming snapshot is missing; it never overrides one that is present.
- **A "skip the override when the item matches the master" gate must not fire on a status transition.** done→calendar (reopen/undo) needs the override, because that is what clears the ✓ marker and the colorId.
