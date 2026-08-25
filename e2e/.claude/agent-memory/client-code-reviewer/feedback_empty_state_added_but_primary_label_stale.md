---
name: empty-state-added-but-primary-label-stale
description: Adding an empty-state message to a card fixes the blank-card read but leaves the pinned primary button asserting a completion ("All inboxes clear") that the new message denies
metadata:
  type: feedback
---

When a diff adds an empty-state branch to a collection-driven card, check the PRIMARY BUTTON's
label in that same branch. The empty state and the button are rendered by different parts of the
component (card body vs. portaled/pinned action bar), so the author fixes the body and never
revisits the label.

**Why:** the weekly-review checklist stage gained "No external inboxes to clear — add some, or
continue." while `stageContinue` kept reading "All inboxes clear — continue". The button asserts a
tick-off the user never performed, in a card whose own message says there was nothing to tick. That
is the SAME defect class the change was fixing (UI claiming a state that isn't real) — the card
stopped looking broken but the button started lying. Same round: the message said "add some" while
the only control was labelled "Edit inboxes" — a verb mismatch that makes the instruction a dead
end, since nothing on screen is named "add".

**How to apply:** on any diff introducing an `{hasX ? rows : <EmptyMessage/>}` ternary, grep the
rest of the component for the enabled/primary action and read its label aloud against the empty
message. Ask (a) does the label assert a user action that didn't happen, and (b) does the empty
message name a verb that no visible control offers. Both usually need the same `hasX` predicate the
ternary already computes — hoist it to a named `const hasInboxes = hasAtLeastOne(...)` and branch
the label too. Related: [[feedback_removed_row_leaves_degenerate_empty_state]] (the prior round that
created this empty state), [[feedback_text_folded_into_hover_only_tooltip]].

**Validated fix shape (round N+1, accepted):** ternary on the same hoisted predicate for the label
(`hasX ? 'All inboxes clear — continue' : 'Continue'`), empty message quoting the literal control
label, and a one-line comment on the label branch saying why the claim would be false. Do not ask
for a separate unit test of the label — this repo's vitest runs in the node env with no DOM, so a
hook-consuming component (`useAppData()`) is only reachable from e2e. Accept the e2e assertion as
the coverage layer for render-branch copy in `components/`.
