---
name: id-remap-cursor-stale-index-fallback
description: Queue/list "re-map ids onto canonical form" helpers clamp the cursor with Math.min(oldCursor, newLen) instead of shifting by removals-before-cursor, silently skipping entries the user never saw.
metadata:
  type: feedback
---

When a helper collapses/re-maps a positional list (weekly-review `normalizeCalendarQueue`, and any future sibling), its cursor fallback is written as `Math.min(queue.cursor, pending.length)`. That is only correct when the removals happened AFTER the cursor. If entries BEFORE the cursor collapsed away, the old index now points past its intended slot and the walk silently jumps over entries the user never saw.

**Why:** the same file already has the correct idiom twice — `mergeQueueWithEligible` and `placeAtCursor` both compute `removedBeforeCursor` and subtract it. The new helper reaches for the naive clamp because the primary path (`pending.indexOf(canonicalOf(current))`) usually succeeds, so the fallback is only exercised when the current entry's canonical form was already decided — a case the author's tests never construct.

**How to apply:** for any new list-remapping helper, construct the adversarial case explicitly: several entries BEFORE the cursor that fold away, and a current entry whose canonical form is absent from the new list (already decided/dropped). Assert `currentQueueItemId` is the entry that was next-unvisited, not `pending[oldCursor]`. Also check the twin symptom on the sibling arrays (`droppedIds`), where remapping one occurrence's drop silently promotes it to a drop of the whole collapsed group. See [[ghost-rows-leak-into-derived-counts]] for the same "audit every consumer of the remapped array" discipline.
