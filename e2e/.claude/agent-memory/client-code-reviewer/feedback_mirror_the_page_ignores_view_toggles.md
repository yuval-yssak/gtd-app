---
name: mirror-the-page-ignores-view-toggles
description: "Walk items in the exact order the page shows them" changes mirror the page's flat sort and miss that the route defaults to a grouped/toggled view.
metadata:
  type: feedback
---

When a change claims a derived surface (weekly-review stage, wizard, digest) presents items "in the EXACT order its list page renders them", verify against the page's **default** render branch, not its top-of-function `.sort(...)`.

**Why:** `/waiting-for` computes a flat `expectedBy` sort, but that array only reaches the DOM under `sortBy === 'date'`; the route defaults to `sortBy = 'person'` and renders `sortGroupEntriesByPersonName(groupByWaitingForPerson(...))` — person groups A→Z, "Unassigned" last. The review stage copied the flat sort and its comment asserted page parity that was false for the default view. Several sibling pages (tickler, calendar) also re-group after sorting; there the grouping preserves the flat order, so the sort IS the render — which is exactly why the one page that diverges slips through.

**How to apply:** for each stage/page pair, read to the JSX and find the branch that actually maps the array. Look for a `useSearch()` param with a default (`const { sortBy = 'person' }`), a ToggleButtonGroup, or a `groups`/`sortedGroupEntries` variable that supersedes the flat list. If the flat sort is only one of two views, either reuse the page's grouping helpers (usually already extracted into `lib/`) or make the comment state the divergence and why — do not let a false parity claim stand.

Related: [[feedback_grouped_comparator_reused_flat]], [[feedback_new_list_chrome_skips_empty_gate]].
