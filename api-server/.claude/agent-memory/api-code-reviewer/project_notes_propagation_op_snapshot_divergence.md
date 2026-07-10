---
name: notes-propagation-op-snapshot-divergence
description: propagateRoutineNotesToItems builds op snapshot from pre-read item but writes field-scoped $set; a concurrent non-notes edit to a still-live row makes the op snapshot stale
metadata:
  type: project
---

`applyNotesToLiveItem` (calendarItemNotes.ts) records the op snapshot as `{ ...item, notes, updatedTs: ts }` reconstructed from the **pre-read** item, while the DB write is a field-scoped `$set:{notes,updatedTs}` (`$unset:{notes}`). The `modifiedCount === 0` guard suppresses the op only when the row was trashed/re-homed — it does NOT cover a concurrent regen that changed a *different* field (e.g. `timeEnd`) on a row that is still `status:'calendar'`.

**Why:** the 2026-07-10 fix closed the zombie-duplicate + op-churn bug via conditional `updateOne` instead of `replaceById`, but the recorded op snapshot is still built from the stale in-memory item, not a re-read. Under a same-cycle non-notes edit to the same live row, the emitted op carries a stale value for that other field; because both writes stamp `updatedTs`, a later pull could momentarily revert the concurrent edit on other devices (same class as [[snapshot-replace-defeats-lww-on-concurrent-edits]]).

**How to apply:** narrow (needs a concurrent non-notes edit to the same live item in the same cycle) and arguably inherent to snapshot-per-op sync, so it did not block approval. If a revert-flicker is ever reported on routine calendar items, the fix is to re-read the row after the update and build the op snapshot from the fresh doc. Demand a partial-concurrent-edit test (mock findArray stale `timeEnd:A`, DB row `timeEnd:B` still calendar, assert DB keeps B) if this path is touched again.
