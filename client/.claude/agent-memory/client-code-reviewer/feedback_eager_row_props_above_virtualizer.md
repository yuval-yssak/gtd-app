---
name: eager-row-props-above-virtualizer
description: Per-row derived props computed in the parent's .map() above WindowVirtualizer run for EVERY row each render, defeating windowing on the unbounded done/trash archives.
metadata:
  type: feedback
---

A new per-row derived prop (e.g. a summary string) computed inline in `sorted.map((item) => <Row prop={derive(item)} />)` above `WindowVirtualizer` runs for all N rows on every parent render (search keystroke, sort, ghost exit, refresh). The virtualizer only limits mounting, not prop evaluation. Worse when `derive` rebuilds a Map of all people/contexts per call.

**Why:** the archive lists are unbounded (done-only 12-month local window) and the memo + virtualizer exist specifically for perf; the regression is invisible in e2e/stories with ~7 rows.

**How to apply:** when a row gains a computed prop, ask for the derivation to move inside the memoized row (pass stable lookup Maps built once in a parent useMemo), so only mounted rows pay. Related: [[virtualization-breaks-exact-dom-counts]].
