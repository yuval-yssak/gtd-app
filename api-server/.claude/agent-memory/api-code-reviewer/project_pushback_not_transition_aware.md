---
name: pushback-not-transition-aware
description: handleItemPush dispatches on snapshot.status, not on the transition — a trash→trash edit re-runs the Google delete/cancel, so any per-op GCal policy (gcalMeta sidecar) is undone by the next unflagged op
metadata:
  type: project
---

Item pushback (`handleItemPush`) has no notion of "the previous status": every item op whose snapshot is `trash` re-runs `deleteEvent` / `pushRoutineInstanceCancellation`. Before 2026-11-27 that was harmless (re-cancel of an already-cancelled instance). The missed-occurrence feature (`gcalMeta.keepGoogleEvent`, feat/routine-past-occurrences) made it load-bearing: the flag lives only on the one op, so a later notes edit of the trashed row (client `/item/:id` allows status `trash` in EDITABLE_STATUSES; `/v1` PATCH accepts edits on trash rows) cancels the kept Google event.

**Why:** op-sidecar policies (chosen so nothing lingers on a restored row) only govern the op they ride on; pushback re-derives Google intent from the snapshot on every later op.

**How to apply:** when reviewing any new per-op GCal sidecar or a "skip Google for X" rule, ask what the NEXT op on the same row does (edit while still in that status, Retry after the row moved on, hard delete via removeItemGCalPresence). Suggested fix shape: compute "entered this status" at apply time (pre-apply row, like hydrateCalendarDetachSnapshots) and persist it on the op so Retry still sees it. Related: [[public-api-writes-bypass-gcal-invariants]].

Follow-up (2026-11-27 re-review): the fix stamps `op.rowAlreadyTrash` in `hydrateItemCarryForwards`, but the BATCH path (`applyAndPublishOperations`, i.e. every `/sync/push`) hydrates all ops in parallel against the PRE-BATCH row — a second op for the same entity in one batch never sees the first op's status. Any "prior state" decision made in a batch hydrator must thread the previous same-entity op's snapshot, in queue order. Check this whenever a hydrator derives a transition.
