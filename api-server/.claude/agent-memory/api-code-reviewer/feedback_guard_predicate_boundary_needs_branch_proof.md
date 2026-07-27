---
name: guard-predicate-boundary-needs-branch-proof
description: Tests for a pass-through guard (`<=`, `>=`) pass identically under the wrong operator unless they assert the side effect proving which branch ran
metadata:
  type: feedback
---

A guard whose "reject" branch rewrites a value to `now` and whose "accept" branch passes through
is **untestable by value assertion at the boundary**: when `value === now`, both branches produce
`now`, so flipping `<=` to `<` breaks nothing visible. The equality case is usually the *most
common* case in production, and it's the one the tests silently don't cover.

**Why:** Found on the `clampUpdatedTs` delta — three good, mutation-verified tests, but all three
picked strictly-future or strictly-past fixtures. The `<=` vs `<` boundary was unpinned, and
`updatedTs === now` is what every server-authored op looks like.

**How to apply:** When a new guard has a pass-through branch, require a boundary test that asserts
an observable side effect unique to the branch taken — spy on the `console.warn`/log the reject
branch emits and assert `not.toHaveBeenCalled()`. Value equality alone proves nothing there.
Related: [[project_regen_done_unmask_test_nondiscriminating]] (same class — a fixture that passes
under the bug too).
