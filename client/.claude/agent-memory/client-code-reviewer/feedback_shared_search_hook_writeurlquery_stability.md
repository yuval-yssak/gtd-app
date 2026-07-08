---
name: shared-search-hook-writeurlquery-stability
description: useListSearch takes a writeUrlQuery callback; call sites whose useCallback closes over full urlState churn its identity, re-running the debounce effect — verify no lost/looping writes.
metadata:
  type: feedback
---

When a shared search/URL hook takes an injected `writeUrlQuery` (or similar navigate wrapper) as a dep of a debounce `useEffect`, scrutinize each call site's `useCallback` deps. Sites that spread the whole URL search bag (`[...urlFilters, ...]`, e.g. next-actions merging `q` with filter chips) give `writeUrlQuery` a NEW identity every time the URL changes, which re-fires the debounce effect.

**Why:** this is the load-bearing correctness path for the in-page search on virtualized list pages — a churning callback can drop a pending write or loop. In the reviewed change it was actually safe: after the debounced navigate lands, `queryInput === urlQuery` so the re-run early-returns without rescheduling; and mid-type filter changes reschedule against the *current* merged bag, so no filter is lost.

**How to apply:** trace type→URL→re-render→effect-rerun for each call site. Confirm the early-return guard (`queryInput === urlQuery`) breaks the loop, and that a rescheduled write merges the latest sibling params rather than a stale snapshot. Flag any site missing the guard or merging a captured-stale bag.
