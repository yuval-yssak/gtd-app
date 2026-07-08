---
name: virtualization-breaks-exact-dom-counts
description: Wrapping a list in virtua WindowVirtualizer invalidates every exact mounted-row assertion (unit + e2e) and every derived action that assumed the whole list was in the DOM.
metadata:
  type: feedback
---

Introducing virtua's `WindowVirtualizer` on a page means only rows near the viewport mount. Two ripple effects that must be checked together whenever this pattern lands:

1. **Tests:** any `toHaveCount(N)` on rows, or `[data-list-item-id]` counts, becomes wrong by design. They must become `.first()` `.toBeVisible()` readiness checks or `<`/`>` margin assertions. Confirmed done in this repo for list-scroll-restoration.spec + the new list-virtualization.spec.
2. **Find-in-page replacement:** offscreen rows aren't in the DOM, so browser Ctrl+F can't see them — every virtualized page needs an in-page search field as the substitute (shared useListSearch + ListSearch components here).

**How to apply:** when reviewing a virtualization change, grep the page's e2e/unit specs for exact counts, and confirm an in-page search shipped alongside. Also audit any derived action that iterated the rendered list (see [[ghost-rows-leak-into-derived-counts]]).
