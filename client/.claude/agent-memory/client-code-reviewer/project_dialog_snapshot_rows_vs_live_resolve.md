---
name: dialog-snapshot-rows-vs-live-resolve
description: New confirm/choice dialogs store StoredItem snapshots in state and write them back on confirm; useFutureDoneConfirm's live-resolve-by-id pattern is not followed. Also null-content flash on exit animation.
metadata:
  type: project
---

Choice dialogs that act on rows (e.g. the Weekly Review overdue-occurrences chooser, 2026-11-27) keep `StoredItem[]` in state at open time and pass those snapshots to `clarifyToDone`/trash on confirm. `useFutureDoneConfirm` (FutureDoneConfirmDialog.tsx) explicitly documents why that is wrong: the dialog stays open across syncs, so a click-time snapshot overwrites remote edits under LWW or revives a row trashed/done meanwhile.

Second recurring slip in the same dialogs: the open state is "payload !== null", so on close the payload is nulled and the dialog's text/counts render empty ("0 ...", "All 0 done") during the exit animation. FutureDoneConfirmDialog keeps the item after close for exactly this.

**Why:** both are invisible in e2e (fixtures don't sync mid-dialog; exit animation is not asserted).
**How to apply:** for any new dialog that writes rows on confirm, demand ids in state + resolution against live `allItems` (filtered to still-eligible status) at confirm time, via a pure unit-tested helper; and a separate open flag so content survives close. Related: [[editor-local-status-outlives-eligibility]].
