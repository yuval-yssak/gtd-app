---
name: feedback-keyed-reorder-focus-loss-one-direction
description: Keyboard reorder/roving-focus diffs restore focus for only one move direction and their e2e re-focus the row before every key press, hiding the loss.
metadata:
  type: feedback
---

React's keyed reconciliation moves the node whose old index is BEHIND lastPlacedIndex. A row
moved DOWN gets its own DOM node moved (focus drops to body); a row moved UP stays put (the
neighbours move). So a refocus that only runs at one moment (e.g. a single rAF after drop,
before the async commit re-renders) passes for upward moves and silently loses focus for
downward ones (Alt+↓ twice only moves once). Seen on exp/next-actions-keyboard 2026-10-23.

**Why:** the e2e specs called `row.focus()` before every key press and only asserted focus after
an upward drop, so the loss was invisible.

**How to apply:** for any keyboard move/reorder, trace the React move for BOTH directions through
drop → stale render → commit render; demand an e2e that presses two consecutive downward moves
without re-focusing. Also check end-of-gesture refocus doesn't fire after a focus-leaving cancel
(Tab/click elsewhere) — that steals focus back. Related: MUI ButtonGroup `disabled` is overridden
by a child's explicit `disabled={false}` (resolveProps keeps defined child props).
