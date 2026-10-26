---
name: confirm-gate-stale-snapshot
description: Wrapping a one-click disposal (clarifyToDone/Trash) in a confirm dialog captures the render-time item snapshot; confirming minutes later writes it back with a fresh updatedTs and LWW-clobbers remote edits.
metadata:
  type: feedback
---

When a change inserts a confirm step in front of an existing row/card action (`confirmX(item, () => onDone(item))`), the thunk closes over the item from the click's render. `disposeItem` spreads that snapshot + `updatedTs: now`, so a remote edit, a remote trash, or a routine materializer swap that lands while the dialog is open gets overwritten on confirm (and a remotely trashed item is resurrected as done).

**Why:** the click-to-write window used to be milliseconds, so the stale closure never mattered; a modal makes it human-scale while SSE pulls keep applying. ItemEditorBody is the exception — commitSave re-reads liveItemRef.current — which makes the gap easy to miss when reviewing the editor path first.

**How to apply:** for any new confirm gate, check that the confirm handler re-resolves the entity from current provider state (allItems by _id) and bails when it is gone or no longer in the gated status. Ask for a hook test that swaps the item between open and confirm. Related: [[own-echo-resurrects-local-delete]].
