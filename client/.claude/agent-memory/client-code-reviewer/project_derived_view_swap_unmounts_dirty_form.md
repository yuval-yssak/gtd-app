---
name: derived-view-swap-unmounts-dirty-form
description: Editor read-only/fold swaps derived from live data (saved status, brief freshness) flip under a mounted dirty form or active notes editor when sync/generation lands.
metadata:
  type: project
---

Editor "rest" views (review details summary vs form, notes folded behind "Show notes") keep getting gated on predicates over LIVE data — `liveItem.status === selectedStatus`, `briefState(...) === 'fresh'`. Those flip from a remote op, the 15-min brief sweep, or the user's own Generate-brief click, and the swap unmounts a form/editor the user is in the middle of (unsaved values then hidden behind a summary of the remote values; focus dropped).

**Why:** seen on feat/review-summary-card (2026-11-19): summary shown when selected==saved status, so a remote clarify to the same status hid a dirty form; notes fold extended to the item page where Generate brief immediately folds the editor that was just written in.

**How to apply:** for any new "collapse/summary when X" predicate, ask what flips X asynchronously and whether the expanded state latches once the user interacts. Expected fix = a one-way latch (set expanded on chip pick / on entering edit), not more predicate terms. Related: [[editor-local-status-outlives-eligibility]].
