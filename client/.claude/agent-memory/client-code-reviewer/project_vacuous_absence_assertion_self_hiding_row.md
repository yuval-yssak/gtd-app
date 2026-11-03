---
name: vacuous-absence-assertion-self-hiding-row
description: e2e "row is absent" (toHaveCount(0)) checks for the Position row pass vacuously when the fixture leaves the item alone in its visible section — compact row self-hides at total<2 and tickler-hidden rows are excluded
metadata:
  type: project
---

Negative e2e/story assertions on a gated UI element keep arriving without a fixture that would make the element render if the gate were removed. Seen 2026-11-03 on the revisit-card Position row: a tickler-stage "no row" test seeded only snoozed items; `daySectionOf` drops tickler-hidden neighbours and the compact row returns null at total < 2, so the test passed regardless of `hasPositionRow`.

**Why:** the author's "it failed before the fix" claim usually covers only the positive case; the negative twin is never flipped.

**How to apply:** for every `toHaveCount(0)` / `queryBy...toBeNull()` on a conditionally-rendered control, check the fixture would show it with the gate forced on (for the Position row: a VISIBLE same-section neighbour). Ask the author to flip the gate once and watch it fail. Related: [[project-e2e-picker-visibility-not-selection]].
