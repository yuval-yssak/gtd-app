---
name: completion-sweep-counts-own-side-effects
description: "Unreviewed arrivals" detectors count items the review's OWN decisions moved between stages; the resolved rule is that focus decisions are settled placements but clarify decisions are not.
metadata:
  type: feedback
---

A "did anything arrive in a stage you already finished?" detector must decide, explicitly, which of the review's *own* decisions count as arrivals — per-stage seen sets alone always get this wrong.

**Why:** weekly-review stages partition one item set by status/tickler date, so nearly every decision relocates an item into another stage's eligibility. Seen-ness tracked per-stage (`queue.pending` + `decidedItemIds` + `droppedIds`) never marks the item seen in the destination stage, so snoozing a nextAction re-surfaced it as a *Tickler* arrival seconds later. Two stages can also share one eligibility predicate (`clarify` and `finalSweep` are both `status === 'inbox'`), double-reporting every late capture and jumping the user back to stage 2.

**Resolved rule (user's design call, `unreviewedStageArrivals` / `focusStageDecidedIds`):** a FOCUS-stage decision (snooze/release/done) is a *settled placement* — those ids are excluded from arrivals in every stage. A CLARIFY-stage decision only determined what the item *is*; the resulting list entry was never reviewed in its list's context, so clarify-decided ids deliberately still count as arrivals for the focus stage they landed in. That is the primary scenario the feature exists for. Duplicate-predicate stages are handled by scanning only the later one (`SWEPT_STAGES` = focus stages + finalSweep; clarify excluded as finalSweep is the inbox catcher).

**How to apply:** when reviewing any cross-stage "you missed these" computation, build the matrix of stage→stage transitions a normal decision can cause and check each. Ask which decision kinds are settled vs. merely reclassifying — the answer belongs in a comment, not implied. Also check for two stages sharing an eligibility predicate.

Related: [[feedback_count_label_scope_narrowing]], [[feedback_free_navigation_invalidates_one_way_state]].
