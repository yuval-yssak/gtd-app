---
name: duplicated-order-declarations-drift
description: An id tuple plus a parallel definitions array encode the same ordering twice; typed as ReadonlyArray<Definition> the compiler accepts any permutation or omission, so a one-line edit can strand stageIndexOf at -1.
metadata:
  type: feedback
---

When a module declares BOTH a `const X_IDS = [...] as const` tuple (deriving the union type) and a
parallel `X_DEFINITIONS: ReadonlyArray<Definition>` array, treat the duplicated ordering as a
standing defect and say so — even when the diff under review edited both correctly.

**Why:** In `reviewFlowState.ts` the stage order is written twice. `REVIEW_STAGES` is annotated
`ReadonlyArray<ReviewStageDefinition>`, which discards literal types — so a permutation, a
duplicate, or a DROPPED entry all type-check, and no test compared the two. The reorder diff had to
hand-edit both in lockstep and got lucky. The dangerous direction is editing only the tuple (or
dropping a definition): `stageIndexOf` then returns -1 for a still-valid id, `jumpToStage` clamps
-1 to 0, and every `?stage=` deep link plus every sweep-screen row silently teleports the user to
stage 1.

**How to apply:** Recommend `as const satisfies ReadonlyArray<Definition>` on the definitions array,
derive the union as `(typeof DEFS)[number]['id']`, and derive the id list with `.map()` — one
ordering, drift impossible, and it matches CLAUDE.md "TypeScript" (mapped/derived types over casts).
Regardless of whether they take the derivation, require a test asserting
`DEFS.map(d => d.id)` equals the tuple AND that no id resolves to -1 through the index lookup. Also
ask whether the ORDER itself is pinned by any test: order-as-product-behavior usually ends up
encoded only in magic indices and e2e walks, so reverting the source file leaves the unit suite
green except for one confusing index mismatch.

Related: [[feedback_reordered_list_breaks_persisted_ordinals]],
[[feedback_testid_constant_lists_untethered_from_render]]
