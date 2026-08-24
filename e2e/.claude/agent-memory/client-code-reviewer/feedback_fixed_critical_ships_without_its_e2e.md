---
name: fixed-critical-ships-without-its-e2e
description: A critical flagged in review round N gets a correct code fix in round N+1 but no test pinning it — the follow-up batch adds tests for the refactor's new pure helpers and leaves the original bug unpinned
metadata:
  type: feedback
---

Round-2 batches in this repo reliably ship excellent tests for whatever *new abstraction* the fix
introduced (pure state helpers, coercion functions — these get unit-pinned and survive mutation
testing) while the **originally-reported bug** keeps no regression test at all.

Concretely: the clarify-to-routine orphan-routine critical was fixed by adding
`ItemEditorActionsApi.isRoutineDestination` and arming `undefined` undo at both stages' save
clicks. Correct fix. But `weekly-review.spec.ts` contains no routine path whatsoever — the only
thing verifying C1 is reading the code. The tests that *were* added covered `removeDecision`,
`requeueAtHead`, `requeueReadiness` and the draft coercions: all real, none of them C1.

**Why:** the fix author's attention is on the mechanism they built, and the new mechanism is what
feels untested. The bug itself now feels "handled" because the code visibly handles it.

**How to apply:** on any re-review, re-read the round-1 critical list and ask, for each item,
"which test fails if I revert this specific line?" Revert it mentally and check. For hidden-branch
fixes (`{decision.undo && <UndoButton/>}`) the pin is a `toHaveCount(0)` assertion plus a check
that the sibling entity survived — see [[conditional-render-gate-loses-coverage]]. Related:
[[snapshot-undo-ignores-compound-mutations]].
