---
name: new-side-effect-skips-existing-mutation-test
description: When a feature adds a side effect to itemMutations clarify*/removeItem, the new-lib unit test covers the lib but the existing itemMutations.test.ts is left without an assertion for the wiring.
metadata:
  type: feedback
---

Features that thread a new side effect through the `db/itemMutations.ts` clarify*/removeItem helpers tend to ship with thorough unit tests for the *new* lib module (e.g. `listGhosts.test.ts`) but leave the existing `itemMutations.test.ts` — which already exercises every clarify path — without a single assertion that the helper actually fired the side effect.

**Why:** the author mentally files the feature under "new module" and tests there; the mutation layer feels "already covered" because its tests are green. But the wiring (the `if (previous.status !== updated.status)` guard, the `if (existing)` guard in removeItem, the "no-op status change records nothing" negative case) is the load-bearing integration point and goes unpinned.

**How to apply:** whenever a diff adds a call inside a clarify*/removeItem/updateItem helper, require the assertion in `itemMutations.test.ts` (not only the new lib's test): positive case per relevant helper, plus the negative case for any guard (missing entity, unchanged field). Reset any module-level store in `afterEach`. Related: [[passthrough-helper-untests-wiring]].
