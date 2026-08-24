---
name: free-navigation-invalidates-one-way-state
description: Adding free/non-linear navigation to a wizard makes previously-unreachable states reachable — one-way append-only accumulators (skippedStageIds) become wrong
metadata:
  type: feedback
---

When a linear wizard gains free navigation (clickable stepper, deep-linkable `?stage=`, back/forward),
state helpers written under the old "you only ever move forward" assumption silently become wrong.
They still typecheck and their original unit tests still pass, because the newly-reachable
transitions were previously impossible to express.

The tell is an **append-only accumulator with no inverse**: `skippedStageIds: [...prev, id]` has no
`unskip`, no dedupe, and no "this stage was subsequently completed" reconciliation. After free jumps
a user can skip a stage, return, review it fully — and the completion screen still reports "skipped";
or skip the same stage twice and get a duplicated entry.

**Why:** the queue/per-item state got rebuilt for revisits (`refreshQueueOnEntry`) because revisit
semantics were the headline feature; the *stage-level* accumulator was not revisited because nothing
in the diff touches it.

**How to apply:** on any diff that adds non-linear navigation, enumerate every piece of flow state and
ask "can this now be entered twice, or entered after the state it records was invalidated?" Prefer
deriving the flag at read time (a stage is "skipped" iff advanced-past AND nothing decided) over
storing an append-only list. Cheap check: write a throwaway test that jumps back and re-enters, and
assert the summary/stat output — the existing suite won't cover it. Related:
[[feedback-itemeditorbody-onclose-overloaded-as-decision]].
