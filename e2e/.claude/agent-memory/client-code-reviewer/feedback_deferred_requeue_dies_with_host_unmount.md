---
name: deferred-requeue-dies-with-host-unmount
description: Hooks that defer a state commit until a refreshed snapshot arrives (write → setPending → effect watches allItems) lose the commit entirely if the host unmounts first — the IDB write already landed, so the two halves diverge
metadata:
  type: feedback
---

The pattern "mutate IDB, stash `{id, expectedTs}` in state, and let an effect apply the *other*
half of the change once `allItems` shows `updatedTs >= expectedTs`" is the correct fix for
requeueing against a stale snapshot. But the deferred half lives in component state, so any
unmount between the write and the snapshot arrival drops it while the IDB write stays.

Concretely in the weekly review: `useDecisionUndo` restores an item, then waits to remove the
decision-history entry. Navigating stages mid-wait (stepper click; `key={stage.id}` forces a
remount) leaves the item restored in IDB but still recorded as decided, so `refreshQueueOnEntry`
never re-offers it — it disappears from the review with no trace.

**Why:** the deferral was introduced to defeat a *different* race (mid-stage `reconcileQueue` only
removes, never adds), and the fix's own new failure mode — the host going away during the deferral
window — was not considered.

**How to apply:** whenever a diff introduces "await the refreshed snapshot before committing state
X", ask what unmounts the owner of X, and whether the already-committed IDB half is recoverable
without it. Prefer committing the durable half LAST, or hoisting the pending marker to the nearest
component that outlives the navigation. Related: [[free-navigation-invalidates-one-way-state]].
