---
name: project-refresh-resolves-before-transition-commit
description: refreshItems() resolves as soon as the startTransition is scheduled, not when the refreshed list commits; "await refresh + one rAF" is not a render barrier.
metadata:
  type: project
---

`refreshItems()` → `triggerAppResourceRefresh` → `startTransition(setRenderedSnapshot(next))` returns
synchronously; the transition then suspends on the IDB read. Code that does
`await onCommit(); await rAF; refocus / clear preview state / plan the next queued step` assumes the
refreshed rows are on screen — true for small e2e DBs, false for a real account with thousands of
rows. An urgent setState fired in that window renders the OLD snapshot (snap-back, node move, focus
loss), and a queued plan reading `sectionsRef` plans against the stale order.
Seen on exp/next-actions-keyboard 2026-10-23 (settlingGrab clear + runCommit refocus).

**Why:** e2e cannot catch it (IDB read is fast); it only bites on large datasets.

**How to apply:** whenever post-mutation logic waits a frame "for the refresh to render", demand a
data-driven barrier (resolve on a layout effect that sees the new `sections`/item rank, with a
timeout fallback). Related: [[feedback-keyed-reorder-focus-loss-one-direction]].
Also: the item editor's `flushItemTextRef` = local autosave flush PLUS a network `dispatchOpFlush`
(throws offline) — reusing it as a pre-write barrier breaks offline-first.
Same trap, other shape (round 3, 2026-10-23): an in-flight guard (`doneInFlight` Set) released in a
`finally` after `await refreshItems()` reopens while the stale row (still not a ghost — `isGhost`
needs the live status to have changed) keeps its Done button; a second click re-runs clarifyToDone
from the stale snapshot → duplicate routine follow-up. Guards must hold until the row leaves the
rendered list (or check the ghost store), and the e2e must run under `gtd.setItemsReadDelay`.
