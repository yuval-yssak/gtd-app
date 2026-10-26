---
name: gcal-capped-split-tail-phase2b
description: Organizer ENDING an already-split GCal series caps only the `_R` tail master; phase 2b routes it to the rebased-id owner — review checklist for its ordering/destructive-trash risks
metadata:
  type: project
---

Prod 2026-10-26: an organizer added a past UNTIL to a split series' `_R<anchor>` master. Pre-fix,
phase 1 normalized it to the bare id and `findExistingRoutineForEvent` (base-only preference) handed
it to the inactive BASE, so the live successor never capped and kept generating phantom occurrences
whose done markers 400'd. Fix: `isOwnedCappedSplitTail` defers capped `_R` masters whose raw id is a
stored `calendarRebasedEventId` to phase 2b (after phase 2, before phase 3 reap).

**Why it matters for future reviews:** phase 2b's `newlyGainsUntil` path is DESTRUCTIVE (pauses +
trashes items past UNTIL, unsetting calendarInstanceEventId), while the old mis-route was merely
wrong. Its safety on a re-split relies on phase 2 having re-keyed the successor first; if phase 2
throws (isolated catch) or Google's cap and new `_R` arrive in different deltas, 2b caps the live
successor. `newlyLosesUntil` later reactivates the routine, but the trashed future items stay trashed.

Re-review 2026-10-26: added open-`_R`-sibling-in-batch gate (closes the phase-2-failure hole) and a
`hasEndedBy` gate — 2b claims PAST-UNTIL tails only. A FUTURE-UNTIL tail still falls to phase 1 and the
base absorbs it (original mis-route, pre-existing); the chain heal retires the successor once the date
passes, on a full sync only.

PRE-EXISTING bug found here (not in this diff): `updateRoutineFromGCal`'s `newlyGainsUntil` pauses on ANY
UNTIL, and `propagateMasterScheduleChanges` → `regenerateFutureRoutineItems` on an inactive routine
trashes EVERY future item. So an UNSPLIT series the organizer gives a FUTURE end date loses all its real
upcoming meetings in-app. Flag if anyone touches newlyGainsUntil; the fix is to pause only on a past UNTIL.

**How to apply:** on any change to `importRecurringMastersOrdered` phase order or to 2b, check
(1) the ordering test "keeps the successor live when the same delta re-splits" still exists (verified
it fails if 2b moves before phase 2), (2) whether 2b gates on "no open `_R` sibling in the batch",
(3) the own-echo branch has a test, (4) future-UNTIL ("end on date X") pauses the tail exactly like an
unsplit series — inherited semantics, pin it rather than re-derive. Related:
[[gcal-resplit-rekey-and-fault-isolation]], [[until-cap-skip-and-400-terminal]], [[cancelled-master-orphan-sweep]].
