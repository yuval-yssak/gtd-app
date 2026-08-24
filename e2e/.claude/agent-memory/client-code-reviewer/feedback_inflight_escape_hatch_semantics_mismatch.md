---
name: inflight-escape-hatch-semantics-mismatch
description: A "Skip" added as the reassign-in-flight escape hatch gets wired to the host's cycle-to-back skip, which is a no-op on a one-item queue — the prescribed fix lands but the button still does nothing
metadata:
  type: feedback
---

When a review round prescribes "render an escape-hatch button so the blocked state isn't a dead
end", check what the wired handler actually *does* to the host's collection, not just that a button
now exists. Round-robin queues (`skipCurrentItem` = head moves to tail) make Skip a visible no-op
whenever the queue holds exactly one entry — which is the common case for the blocked item.

**Why:** the weekly-review pinned-bar batch fixed the empty reassign-in-flight bar by rendering a
stage-owned "Skip for now" in FocusStage/ClarifyStage wired to `skipCurrentItem`. The sibling
`ProcessInboxWizard` had already solved the same problem with `onSkip={advance}` — an index bump
that moves *past* the item. Cycle-to-back and advance look interchangeable in the diff; they are
not. With one item mid-reassign the button re-renders the same blocked card, and the only real
escapes are the header's "Skip stage" and the timeline stepper, neither of which the fix mentioned.

**How to apply:** for any conditional escape-hatch button, ask "what is the collection size at the
moment this branch renders, and does the handler change what's displayed at size 1?" Compare
against the sibling component that already handles the same blocked state — divergent verbs
(`advance` vs `skip`) across two solutions to one problem is the tell. Related:
[[itemeditorbody-onclose-overloaded-as-decision]], [[graceful-block-drops-bundled-edits]].

**Resolution (validated):** a third verb was the right answer — `dropCurrentItem` removes the head
without recording it in `processedIds`, so it escapes a size-1 queue (unlike skip) and is re-offered
on stage re-entry (unlike complete). Worth knowing for the next queue-backed wizard: complete /
skip / drop are three genuinely distinct outcomes, and a blocked-by-external-state item wants drop.
The drop survives the mid-stage `reconcileQueue` effect because that effect only removes entries,
never adds — verify that property before assuming a drop sticks.
