---
name: gcal-moved-row-foreign-date-class
description: Recurring GCal bug class — a moved routine instance sits on a date it does not "own", and every date-keyed consumer (tier-2 resolve, regeneration, content/title propagation) silently mis-targets it
metadata:
  type: project
---

A GCal-moved routine occurrence lives at a `timeStart` whose calendar date belongs to a
DIFFERENT occurrence of the same series. Every code path that keys a routine item by
`timeStart.slice(0,10)` therefore mis-identifies it. This has now produced at least three
distinct production incidents (moved-instance-lost, disappear/duplicate variants, and the
"ALL HANDS" create/trash flip-flop that burned ~1,580 dead rows / ~4,700 ops in 30 hours).

**Why:** the codebase's canonical identity for an occurrence is `calendarInstanceEventId`
(anchored to the ORIGINAL occurrence date, stable across moves), but several consumers
predate it and still key by date. The two identities diverge exactly when a move happens,
which is also exactly when the flip-flop damage is worst — a wrong match is destructive
(trash a live row) and the create-on-miss path re-creates it, so the cycle is self-sustaining
and each iteration emits a web push.

**How to apply:** when reviewing anything touching routine calendar items, grep for
`timeStart` date-slicing and ask "what happens if this row was moved onto another
occurrence's date?" Known date-keyed consumers to check every time:
- `resolveExceptionTarget` tier 2 (calendar.ts) — now guarded by an
  `calendarInstanceEventId: {$exists:false}` legacy-only clause when the exception carries an id
- `futureLiveItemsByDate` / `trashOrphanedItems` / `itemDriftsFromSchedule` /
  `dateSetClaimedByDisposedItems` (routineItemRegeneration.ts) — a moved row keys under the
  destination date, which `buildExceptionDateSet` excludes from `required`, so it reads as an
  orphan and gets trashed. Only reachable when the master rrule/timeOfDay/duration changes, so
  it hides behind an infrequent trigger.
- `propagateRoutineContentToItems` / `propagateRoutineTitleToItems` — look up the per-instance
  override by the item's CURRENT date, so a moved row gets the wrong (or no) override.
- `reviveSkippedOccurrence`'s `trashedFilter` — date-ranged, same exposure.

Also note: fixing the flip-flop at the resolve tier does NOT fix the regeneration/propagation
consumers. They stayed latent because they need a second trigger. Do not treat a resolve-tier
fix as closing the class.

Related: [[review-adversarial-op-loss-tracing]], [[op-cursor-ordering-invariants]]
