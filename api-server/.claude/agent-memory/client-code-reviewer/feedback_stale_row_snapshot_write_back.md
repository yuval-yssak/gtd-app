---
name: stale-row-snapshot-write-back
description: List-row quick-action handlers spread the rendered entity into a full-snapshot update, clobbering concurrent remote edits; dialogs get this right, rows don't
metadata:
  type: feedback
---

Flag any list-row action handler that writes `{ ...entityFromRenderedList, someField: x }` back
through an update mutation. It must re-read the row (from IDB or a live ref) before writing.

**Why:** Sync ops carry a FULL entity snapshot with last-write-wins on `updatedTs`, so a write built
from a render-time copy silently reverts every field a concurrent SSE-delivered remote edit changed
— not just the field the handler meant to touch. The edit dialogs in this codebase already defend
against this (they keep a live ref to the row and build writes from it), which makes the omission in
row handlers easy to miss: the pattern looks locally fine and the correct precedent is in a
different file.

**How to apply:** On any diff adding a per-row icon-button action (archive, pin, toggle, complete),
check the write source. Recommend re-reading the entity immediately before the mutation. Note the
window is small but real on multi-device accounts, so "unlikely" is not a defense — the failure is a
silent data revert, not an error. Contrast against the corresponding dialog in the same feature to
show the author the in-repo precedent.

Related: [[collapse-state-vs-shrinking-option-lists]], [[shared-dialog-refresh-gap]]
