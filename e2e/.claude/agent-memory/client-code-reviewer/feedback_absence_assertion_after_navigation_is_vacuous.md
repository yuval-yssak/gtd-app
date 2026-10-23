---
name: feedback-absence-assertion-after-navigation-is-vacuous
description: e2e "X did not also fire" checks written as toHaveCount(0) on the old page's testid after a navigating shortcut pass trivially; also script-applied N-page wiring gets tested on 2-3 pages
metadata:
  type: feedback
---

When a key both navigates and could have triggered a page-local side effect (`g c` vs a row's C = copy), specs assert the side effect's absence with `toHaveCount(0)` on a testid from the page that just unmounted, which passes no matter what happened. Ask for a durable witness instead: clipboard contents (`navigator.clipboard.readText()` still equal to the earlier value), an IDB row, or the global dialog's testid (`quickCaptureDialog`).

Same increments tend to wire 9+ list pages by script and e2e only 2-3 of them; ask for a cheap table-driven check per page (marker attr + action attr present) rather than trusting the script.

**Why:** seen in the row-shortcut tooltips increment (2026-10-23, exp/keyboard-regions).
**How to apply:** for any "global shortcut wins over local" test, check what the absence assertion is anchored to. Related: [[feedback-testid-constant-lists-untethered-from-render]].
