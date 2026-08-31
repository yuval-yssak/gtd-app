---
name: page-filter-change-desyncs-review-stages
description: Changing a list page's visibility filter leaves weeklyReview stageEligibleItems (which contracts to mirror that page exactly) untouched, plus a private duplicate of the predicate
metadata:
  type: feedback
---

When a list page's visibility filter changes (adding/removing a status from the set, or
adding a gate like the tickler predicate), `stageEligibleItems` in
`components/weeklyReview/reviewFlowState.ts` is reliably missed — even though its doc comment
contracts that each stage "walks its items in the EXACT order its own list page renders them".

Two failure shapes, usually together:
1. **Stale mirror.** The stage keeps the old filter, so the review and the page disagree about
   the same item. Look for stage comments that literally name the page ("Mirrors the /tickler
   page: only nextAction + waitingFor") — those comments become false silently.
2. **Private duplicate predicate.** `reviewFlowState.ts` carries its own local copy of the
   visibility helper at the bottom of the file. A refactor that extracts a shared predicate into
   `lib/` and updates the page call sites will not find this one, because it is a same-named
   local function, not an import.

**Why:** the review stages live in `components/weeklyReview/`, far from `routes/_authenticated/`,
so a route-focused diff never surfaces them. The existing stage tests actively hide the drift —
their names assert the old invariant ("regardless of tickler, newest-first like the someday
page"), so they stay green and read as confirmation.

**How to apply:** on any diff touching a list page's filter or status set, grep
`stageEligibleItems` for the affected status and re-read every stage comment that names a page.
Then grep the file for a local re-declaration of whatever predicate was just centralized. Treat
a green `reviewFlowState.test.ts` as evidence of nothing until you have read the test *names* —
they encode the old contract.

Related: [[feedback_sibling_wizard_stages_duplicate_verbatim]],
[[feedback_new_synced_entity_misses_lifecycle_sites]],
[[feedback_mirror_the_page_ignores_view_toggles]]
