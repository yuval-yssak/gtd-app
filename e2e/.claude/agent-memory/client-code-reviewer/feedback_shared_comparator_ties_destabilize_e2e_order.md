---
name: shared-comparator-ties-destabilize-e2e-order
description: Swapping a total-order sort (createdTs) for a shared tiered comparator that returns 0 on ties makes e2e walk order IDB-key-nondeterministic; seed distinguishing field values.
metadata:
  type: feedback
---

When a list's sort is switched from a total order (e.g. `createdTs.localeCompare`) to a shared tiered comparator that can `return 0`, every e2e that asserts a specific walk/render order becomes flaky.

**Why:** `Array.prototype.sort` is stable, so tied elements keep *input* order — and the input is an IDB `getAll()` by index, whose order is not the creation order the test author assumes. `compareNextActions` returns 0 for two undated same-focus-tier items, so two plainly-seeded next actions came up in arbitrary order. The old `createdTs` sort had masked this because it was a total order over distinct values. The e2e passes locally and fails at some rate in CI, which reads as infra flake rather than a real ordering gap.

**How to apply:** whenever a diff replaces a sort with a comparator that has a `return 0` / tie branch, grep the e2e suite for tests that seed 2+ entities of that type and assert order. Each must seed a value that breaks the tie (distinct `expectedBy`, `focus`, etc.) with a comment saying why — not rely on creation order. Also flag that the comparator's tie branch needs its own unit test. Note this cuts both ways: a test that *wants* to prove tie-stability should pin it explicitly rather than inheriting it.

Related: [[feedback_lifted_helper_leaves_original_test_home]], [[feedback_virtualization_breaks_exact_dom_counts]].
