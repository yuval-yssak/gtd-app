---
name: stored-mirror-gap-closed-without-strippers
description: Adding missing Stored* fields to close a client/server mirror gap makes them reachable by type-switch strippers and generators that still enumerate the OLD short list.
metadata:
  type: feedback
---

"`StoredRoutine` was missing meetingLink/location/htmlLink that the server declares — added them
to close the mirror gap" is a correct and welcome change, but on this codebase the server-side
key set (`GCAL_OWNED_ROUTINE_KEYS`, 8 keys) is **hand-copied into at least three client sites
that each enumerate a shorter list**, and none of them get updated with the type:

1. `db/routineItemHelpers.ts` `mergeGCalOwnedForOccurrence` — mirrors only 5 of 8 onto generated
   items (server's `pickGCalOwnedRoutineMirror` loops all 8). This is *why* the review card
   needed a runtime `representativeEventItem` projection at all — the projection is a workaround
   for the generator gap, not an inherent routine-vs-item split.
2. `components/routineEditor/RoutineEditorBody.tsx` — the `routineType !== 'calendar'` strip
   `delete`s the same 5. The server's `RoutineSnapshotSchema.superRefine` rejects **all 8** on a
   non-calendar routine, so a calendar→nextAction switch on a routine carrying the newly-typed
   fields is a 400 that jams the whole push queue.

**Why:** the fields already arrived at runtime (snapshots are `store.put` verbatim), so the type
addition changes nothing observable and looks free. The jam only fires on a rarely-exercised
type switch, long after the diff.

**How to apply:** whenever a `Stored*` interface gains a field that a server-side `*_KEYS`
constant already declares, grep the client for every literal enumeration of that key set and
check each has the same arity as the server constant. Prefer converting the client sites to loop
a single exported tuple rather than adding one more `delete`/`if` line.

Related: [[feedback_new_synced_entity_misses_lifecycle_sites]],
[[feedback_server_protocol_change_leaves_client_tests_lying]],
[[feedback_duplicated_order_declarations_drift]]
