---
name: collapsed-pseudo-entry-reenters-queue
description: Collapsing N items into one `prefix:<id>` queue entry — the collapse survives the decision that was supposed to retire it, so the entry re-arrives forever
metadata:
  type: feedback
---

When a queue entry is a **derived pseudo-id** (`routine:<id>` standing for N items) rather than a
real row id, check what happens to the entry id after each decision retires it. A decision that
does not remove *every* backing row leaves the pseudo-id still derivable, so the reconcile /
arrivals sweep re-derives it and re-offers the same card.

Concretely in weeklyReview: `pauseRoutine` trashes only **future** items. Any past-due
`status:'calendar'` occurrence survives, still carries `routineId`, and still collapses to the
same `routine:<id>` — which is now in `decisions`. `reconcileQueue` filters it out (decided ids
are `alreadyQueued`), but `stageArrivalCount`'s `settledIds` is built from `focusStageDecidedIds`,
and any *other* stage that re-derives it counts it as unseen.

**Why:** real item ids die with their row; pseudo ids are recomputed from a predicate, so
"decided" and "no longer eligible" stop being the same thing. The whole queue model assumes they
are.

**How to apply:** for any `prefix:<id>` entry, ask three questions:
1. Does every terminal action on the card make the entry ineligible? (Pause does not. Neither does
   "Looks good", which is deliberate — but then the entry must be settled some other way.)
2. Is the pseudo-id in the same namespace as the settled/decided sets it's compared against?
3. Does the derived-entry's backing set differ per stage? (Calendar-only collapse means the same
   routine's nextAction item is a *plain* id in another stage — two ids for one concept.)

Related: [[feedback_completion_sweep_counts_own_side_effects]] (the sweep counting the review's own
side effects), [[feedback_affordance_enabled_by_noop_state]].
