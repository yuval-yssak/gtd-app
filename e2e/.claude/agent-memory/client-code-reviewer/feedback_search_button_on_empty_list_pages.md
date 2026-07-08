---
name: search-button-on-empty-list-pages
description: When adding in-page search to a list page, check whether the header search button still renders on the truly-empty state
metadata:
  type: feedback
---

When the in-page list-search pattern (ListSearchButton/ListSearchField + useListSearch) is extended to a new list surface, watch for the header search button appearing on the truly-empty state (nothing to search).

**Why:** The shared `ArchivedItemsView` returns early on `archivedItems.length === 0` with a header that omits the search button — the correct behavior. But `someday.tsx`, when refactored to a single `return` with a `renderBody()` branch, now renders the header (including `ListSearchButton`) unconditionally, so the button shows even on the "Nothing parked yet" empty card. Offering search over an empty list is a small UX inconsistency between sibling pages.

**How to apply:** For any page gaining this pattern, confirm the true-empty branch either hides the search button or the team has decided to always show it. Flag divergence between pages that share the pattern (someday vs done/trash).
