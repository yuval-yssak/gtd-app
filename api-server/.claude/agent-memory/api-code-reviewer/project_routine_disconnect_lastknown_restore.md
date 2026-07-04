---
name: project-routine-disconnect-lastknown-restore
description: Routines now rename link fields to lastKnown* on BOTH keep+remove disconnect; reconnect restore reactivates on open inbound rrule and double-regens items (idempotent). Review checklist for this path.
metadata:
  type: project
---

`trashRoutinesForIntegration` (remove-mode disconnect) now deactivates AND renames link fields to `lastKnown*` (with accountEmail stamp), mirroring the keep path, so a same-account reconnect RESTORES the same routine doc instead of minting a twin. Restore delegates to shared `restoreRoutineCalendarLink`.

**Why:** remove-mode disconnect used to leave `calendarEventId`/`calendarIntegrationId` pointing at the deleted integration; the integration-scoped strong-key lookup on reconnect never matched → duplicate "twin" routines. Fixed 2026-07-04 (working tree, uncommitted at review time).

**How to apply — review checklist for any change in this path:**
- `restoreRoutineCalendarLink` REACTIVATES iff `!active && rrule open (no UNTIL)`. Rationale: user pause always caps with UNTIL, so inactive+open-inbound == disconnect-inflicted. A capped inbound rrule (split base) stays inactive — verify this gate on any edit.
- On reactivate it regenerates future items, THEN `updateRoutineFromGCal` (which runs next because findExistingRoutineForEvent returns the restored routine) may regen AGAIN via `propagateMasterScheduleChanges`. Both regens are idempotent-delta (`regenerateFutureRoutineItems` reconciles the `status:'calendar'` set), so no dup — but any change that makes regen non-idempotent breaks this. The restore does NOT set `lastSyncedFromGCalTs`, so `structurallyNewer` always fires on the follow-up update (epoch fallback) — intentional but means the double-regen path always runs.
- Split successors (`calendarRebasedEventId` set) are EXCLUDED from `tryRestoreRoutineFromLastKnownEventId` (base-only via `.filter(!r.calendarRebasedEventId)`) and owned by `tryRestoreSplitSuccessorFromMarkers` in the phase-2 forceSplitSuccessor branch. Restoring a successor in the base path would overwrite it with the capped base's rrule (flip-flop bug). Verify this split is preserved.
- E11000 from `uniq_active_routine_per_gcal_series` (key: user+calendarEventId+calendarIntegrationId, partial active:true) is caught as a race-loser miss. Base(inactive)+successor(active) on the same bare id don't collide because base isn't in the partial index.
- Rename is second-disconnect idempotent via `calendarEventId:{$exists:true}` guard in `renameCalendarLinkFieldsToLastKnown` — won't clobber prior lastKnown markers.
- Cross-account reconnect: markers wiped by `reconcileLastKnownMarkers`/`wipeOrphanedMarkersForFilter` (covers routines) because accountEmail stamp mismatches live email → restore misses → fresh routine created. See [[project_lastknown_marker_orphan_risk]].

Test gap noted (non-blocking): no coexisting-active-sibling fixture proving the E11000 catch path (only backstop); cross-account test has no routine items so the instance-id wipe isn't exercised for routines.
