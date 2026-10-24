---
name: partial-touch-stoppropagation-stale-start
description: Shielding a child from a parent's swipe by stopping only touchstart leaves touchmove/touchend bubbling into the swipe hook with a stale start X — commits a swipe (trash) on drag/tap of the child
metadata:
  type: feedback
---

When a nested control (drag handle, button) is "kept out of" a parent's touch-swipe gesture by
`onTouchStart={e => e.stopPropagation()}` alone, touchmove/touchend still bubble to the parent's
`onTouchMove`/`onTouchEnd`. `useSwipeGesture` then computes delta against the PREVIOUS gesture's
`startXRef` (or 0), clamps to ±120 and commits on end. Reproduced 2026-10-24 on the inbox phone
drag handle: a sub-threshold body swipe at x=250, then a short handle drag → item trashed.

**Why:** the happy-path e2e ran on a fresh row (startX=0, delta ≈ handle x ≈ 21px < threshold), so it
passed; the bug needs a prior body touch on the same row.

**How to apply:** for any partial stopPropagation of a multi-event gesture, demand all of
start/move/end/cancel be shielded (or a tracking guard in the hook), and an e2e that performs a
prior gesture on the parent first. Verify by instrumenting (probe spec), see [[verify-reviewer-claims-by-instrumenting]].
