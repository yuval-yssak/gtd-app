---
name: lifted-helper-leaves-original-test-home
description: Lifting a pure helper out of a route into lib/ never brings a dedicated unit test with it — the only coverage stays the indirect assertion in the NEW consumer, and the original consumer's e2e is the sole guard on the old behaviour
metadata:
  type: feedback
---

When a pure function is extracted from a route file into `client/src/lib/` so a second consumer can
share it, the change-set consistently ships:

- a unit test asserting the ordering/behaviour **through the new consumer** (e.g.
  `stageEligibleItems('nextActions', …)`), and
- **no** unit test on the lifted function itself, even though it is now an exported public module
  with its own file.

The pre-existing coverage on the original consumer is usually an **e2e only** (e.g.
`e2e/next-actions-sort.spec.ts` was the sole guard on the four-tier next-action comparator). So
after the lift, the tier logic has one indirect unit assertion and one slow browser test, and the
comparator's own edge cases (the `return 0` tie branch, undefined-vs-empty-string `expectedBy`,
`focus: false` vs absent) go untested at every level.

**Why:** the author's mental model is "verbatim move, already covered" — but the point of the lift is
that the function is now a shared contract, and shared contracts are exactly what deserve a
direct test. A `return 0` tie branch is also where stable-sort dependence hides: both consumers
happen to feed the same `items` array from `useAppData()`, so ties agree today by accident of a
shared input, not by the comparator's design.

**How to apply:** whenever a diff adds a file under `lib/` whose body is byte-identical to a deleted
block elsewhere, check for a matching `client/src/tests/<newModule>.test.ts`. If absent, ask for one
and specifically for the total-order/tie branch. Also grep `e2e/` for a spec named after the ORIGINAL
consumer — if that spec is the only prior coverage, say so explicitly, because it will not run in the
inner unit loop.

Related: [[extracted-body-diverges-from-shared-chrome-type]], [[fixed-critical-ships-without-its-e2e]].
