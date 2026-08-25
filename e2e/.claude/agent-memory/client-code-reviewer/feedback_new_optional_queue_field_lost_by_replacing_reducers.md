---
name: new-optional-queue-field-lost-by-replacing-reducers
description: A new optional field added to a shared reducer-style state object gets preserved only by the reducers the author touched; sibling reducers that build a fresh object literal silently erase it.
metadata:
  type: feedback
---

When a new optional field lands on a shared immutable state object (e.g. `droppedIds` on `StageQueue`, `reviewFlowState.ts`), audit **every** reducer over that type — not just the ones the feature touches.

**Why:** reducers in this codebase are a mix of `{ ...queue, x }` spreads and hand-written object literals (`{ pending, cursor, decisions }`). The spread ones inherit the new field for free; the literal ones silently drop it. The author only checks the reducers they wrote, so the erasure is invisible in review and in unit tests (which test each reducer in isolation, never the composed sequence). Confirmed live: `completeCurrentItem` and `dropCurrentItem`/`excludeFromLiveAppend` diverged this way — one drop followed by one decision wiped the exclusion list and re-armed the exact bug the field existed to prevent.

**How to apply:** grep for every `export function` in the state module that returns the type, and classify each as spread-based or literal-based. Every literal-based one is a suspect. Then demand at least one unit test that composes two different reducers in sequence (`drop → complete → reconcile`), because single-reducer tests can never catch it. Same reasoning applies to persistence: check whether the draft read path (`flowFromDraft`-style rebuilds) also reconstructs a literal and drops the field — that may be intentional, but it must be stated.

Related: [[feedback_new_synced_entity_misses_lifecycle_sites]], [[feedback_two_effects_one_flow_replacement]].
