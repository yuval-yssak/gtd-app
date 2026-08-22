---
name: budget-fix-shortens-retry-loop
description: Adding a short "give up waiting" budget to a rAF retry loop whose exit condition IS the wait flag silently truncates the whole loop — the late-arriving work it existed for never runs.
metadata:
  type: feedback
---

When a fix adds a short deadline to a "keep waiting for X" flag, check whether that same
flag is also the **loop continuation condition**. If it is, capping the flag caps the loop:
the retry chain terminates at the short budget instead of the long one, and every later
frame of work the loop existed to perform is silently dropped.

**Why:** In the list scroll-restoration review, C2 asked for a corroboration budget so a
lone surviving anchor wouldn't stall at the raw pixel for ~1s. The implementation set
`isAwaitingAnchors = ... && framesUsed < ANCHOR_CORROBORATION_FRAMES`, but `applyRestore`
continues on `(wasClamped || isAwaitingAnchors)`. Once the budget expires the chain ends —
so in a virtua windowed list, where the saved rows mount *after* the pixel fallback lands
(the whole reason the 60-frame budget existed), the precise re-anchor pass never runs. The
loop's two concerns — "wait for anchors to appear" and "stop deferring the decision" — were
collapsed into one flag.

**How to apply:** Whenever a retry/polling loop gains a new early-exit budget, separate
"what do I do this frame" from "should I keep looking". Ask: after the new budget expires,
does the loop still run long enough to pick up late-arriving DOM? Also check what the loop
gates as a side effect (here: `isRestoreChainActive` suppressing scroll capture) — an early
exit re-enables that side effect too, so post-exit drift gets **saved** as user intent and
corrupts the stored state.

Related: [[feedback_concurrency_fix_untested_layer]] — same shape, the tests covered the
wiring (`restoreTargetForFrame` in isolation) but not the composition (the rAF chain that
consumes its return value), so the truncation was invisible to the suite.

**Resolution that worked (round 3):** return a named decision object with the two answers as
separate fields (`{ target, shouldKeepWatching }`), where only `target` consults the budget.
The loop's continuation reads the watch flag, so "act early" and "stop looking" are no longer
the same bit. Reviewer verification that caught it: revert the flag to the coupled form and
confirm tests go red — three did. Prefer this mutation check over reading a green suite.
