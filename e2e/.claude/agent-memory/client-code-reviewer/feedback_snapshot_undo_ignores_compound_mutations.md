---
name: snapshot-undo-ignores-compound-mutations
description: A generic "restore the pre-decision StoredItem snapshot" undo silently omits the sibling-entity half of compound mutations (clarify-to-routine, routine series advance) — check every mutation the surface can reach, not just the item write
metadata:
  type: feedback
---

When a new surface adds one-click undo by capturing a `StoredItem` snapshot before the mutation and
replaying it through `updateItem`, the undo is only correct for mutations that touch **one row**.
Several of this codebase's item mutations are compound:

- `clarifyToRoutine` = create routine + seeded items, THEN trash the item. The app's own snackbar
  undo calls `undoClarifyToRoutine` (hard-deletes the routine and everything it generated) —
  a bare snapshot restore leaves an orphan routine duplicating the restored capture.
- `clarifyToDone` / `clarifyToTrash` call `maybeCreateNextRoutineItem` — disposal advances the
  series. That is why routine-generated items are excluded from snapshot undo.
- `saveViaStatusTransition` on a calendar item detaches/deletes the GCal event.

**Why:** the review batch justified its undo as "same semantics as the app-wide offerSaveUndo
snackbar", but `offerSaveUndo` is only one of three undo builders in ItemEditorBody — the sibling
`offerClarifyToRoutineUndo` exists precisely because the snapshot alone is not enough there.
Citing "same as the existing undo" is not sufficient when the surface can reach a save path that
has its own richer undo.

**How to apply:** for any new snapshot-based undo, enumerate the mutations the host surface can
actually invoke (including everything reachable through an embedded `ItemEditorBody`'s save path,
not just the host's own explicit buttons) and check each for a second write. Where a richer undo
already exists next to the mutation, either call it or refuse to offer undo. Related:
[[graceful-block-drops-bundled-edits]].
