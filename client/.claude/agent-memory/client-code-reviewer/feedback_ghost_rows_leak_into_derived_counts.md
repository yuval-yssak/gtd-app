---
name: ghost-rows-leak-into-derived-counts
description: Merging ephemeral ghost/optimistic rows into a page's item pipeline silently inflates every count/empty-state/wizard input derived from that pipeline; each derived value needs a live-only filter.
metadata:
  type: feedback
---

When a feature merges ephemeral rows (ghosts, optimistic rows) into a page's item array *upstream* of its status filter+sort (e.g. `mergeGhostsIntoItems` feeding `itemsWithGhosts`), every value derived from the post-filter array inherits the ghosts: header count chips, "Process Inbox (N)" buttons + their disabled guard, `.length === 0` empty-state branches, and any snapshot passed to a wizard/batch flow.

**Why:** ghosts pass the same status filter as the live row they replaced (they carry the pre-mutation status by design), so `filtered.length` counts them. The reviewed PR correctly added a `liveXCount = filtered.filter((i) => !isGhost(i)).length` for count chips and a `liveInboxItems` for the batch wizard — but this is a per-derivation fix that is easy to forget on the next page or the next derived value.

**How to apply:** whenever a page's row pipeline includes non-live rows, audit EVERY downstream consumer of that array for whether it wants live-only or all rows. Specifically check: count chips, empty-state `length === 0` guards (a list that is all-ghosts still renders rows, which is usually the intended fade-out — verify), disabled-button guards, and any array handed to a mutation/batch/wizard. A single shared `liveItems` derivation reused everywhere is safer than N ad-hoc filters. See [[new-side-effect-skips-existing-mutation-test]] for the sibling test-coverage gap.
