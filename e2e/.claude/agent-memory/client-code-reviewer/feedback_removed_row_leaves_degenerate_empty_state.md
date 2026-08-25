---
name: removed-row-leaves-degenerate-empty-state
description: Deleting a fixed/always-present row from a checklist or list makes the all-dynamic remainder trivially satisfiable at zero; check whether the empty state is user-reachable and permanent
metadata:
  type: feedback
---

When a hardcoded always-present row is removed from a list whose completion is computed over the
remaining dynamic rows, the completion predicate becomes vacuously true at zero rows. Verify (a) the
empty state is reachable by user action, not just on fresh install, and (b) what actually renders —
usually a near-blank container above an already-enabled primary button.

**Why:** the weekly-review "Clear all inboxes" stage dropped its fixed "GTD Inbox" tick row, leaving
`isChecklistComplete` = `inboxIds.every(...)`, which is `true` for `[]`. The author flagged the
zero-inbox case as "acceptable — fresh install only", but `ManageInboxesDialog` has a per-row remove
button with no floor at one row, AND `seedDefaultReviewInboxesIfEmpty` writes a localStorage
`seeded:<userId>` marker precisely so deleted defaults are never resurrected. So "user deleted all
buckets" is a permanent, product-intended state, not a transient one. The fixed row had been silently
guaranteeing the card was never empty and Continue never started enabled.

**How to apply:** on any diff that deletes a static row/entry from a collection-driven completion
gate, trace the mutation surface that manages the collection and ask whether it can reach zero. If it
can, the empty state needs both a test and usually an empty-state message — a blank card over an
enabled primary reads as a rendering bug. Related: [[feedback_new_list_chrome_skips_empty_gate]],
[[feedback_conditional_render_gate_loses_coverage]].

Second, smaller recurring miss on the same class of change: the sentinel/legacy-value compat test
gets written for the *populated* list only. Here `isChecklistComplete(['system'], ['ri-1'])` was
pinned but `isChecklistComplete(['system'], [])` — legacy sentinel AND empty list — was not. Ask for
the legacy value crossed with the new degenerate case.
