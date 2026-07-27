---
name: retired-by-gcal-marker-lifecycle
description: retiredByGCal routine marker — why it exists, every set/clear/skip site, and the review checklist for new reactivation paths
metadata:
  type: project
---

`RoutineInterface.retiredByGCal` (added 2026-07-27) marks a routine deactivated because GCal cancelled
its series. It exists because `healStuckGCalRoutines` ("Repair sync" button) matches `!active || past
UNTIL` — the EXACT shape a retirement leaves behind — and resurrected a real staging retirement,
regenerating 28 phantom items.

**Set sites:** `deactivateRoutineFromGCal` (calendar.ts) and `retireRoutine` + `stampRetirementMarker`
(scripts/retireOrphanedSeriesSuccessor.ts). **Clear site:** exactly one — `clearRetirementMarker` in
`updateRoutineFromGCal`, gated on `structurallyNewer`. **Skip sites:** `isStuckRoutine` and
`isStrandedSuccessor` in lib/calendarHeal.ts.

**How to apply / review checklist when this area changes:**
- **Any new routine-reactivation write must clear the marker**, or it revives a row the heals will then
  correctly refuse to help — a silent half-state. Grep `active: true` across calendar.ts, calendarHeal.ts,
  routineComposites.ts before approving. Audited safe at introduction: `restoreRoutineCalendarLink` and
  `resolveGoneMarkerRoutine` reactivate/deactivate marker routines, but those rows have
  `calendarEventId` UNSET (renamed to `lastKnown*` at disconnect) and both heal predicates require
  `calendarEventId`, so the marker is unreachable there. If a future change keeps `calendarEventId` set
  through a disconnect, that immunity evaporates.
- **The `structurallyNewer` gate on the clear is reachable but easy to leave untested.** The
  `!structurallyNewer && notesUpdate` branch falls through to the same merge; without the gate an
  out-of-order older notes payload clears a marker a fresher cancellation just set. Removing the gate
  passed all 448 calendar tests at introduction — demand a dedicated test.
- **Marker vs cap are two independent defenses.** The heuristic reap passes `capRruleFrom` (keeps
  retirement reversible via `newlyLosesUntil` and keeps `isStrandedSuccessor`'s open-rrule requirement
  from matching); the direct cancelled-master path does NOT cap, so for THAT path the marker is the
  only thing keeping `healSplitSuccessorRoutines` off the row.
- `/sync/push` full-snapshot `replaceById` means a client editing a stale cached copy can silently drop
  the marker (generic LWW risk). `WRITABLE_FIELDS` (v1 routines) and `presentRoutine`'s allowlist
  correctly exclude it; keep it that way.
- `RoutineSnapshotSchema` MUST carry it — see [[project_sync_push_routine_schema_jam]].

See [[project_cancelled_master_orphan_sweep]], [[project_remediation_scripts_review_checklist]].
