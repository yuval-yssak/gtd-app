---
name: inferred-move-direction-from-order
description: Queue rules that infer "the current item moved down" from the new list order also fire when a leftover moved UP (remote edit); and any card swap in the review drops unsaved structural edits
metadata:
  type: feedback
---

A reconcile that decides "current's own rank dropped" by checking whether a leftover now precedes it cannot tell that
apart from "another device raised a leftover above it" (or moved its expectedBy earlier in day-first comparators). The
card on screen then swaps under the user, and the `key={id}` remount of ItemEditorBody silently drops staged
structural edits (only text/brief have unmount flushes). Seen 2026-10-28 in `reconcileQueue`/`layOutTail`.

**Why:** relative order is symmetric; direction needs an explicit signal (the local Position-row move) or the old rank.
**How to apply:** for any rule keyed on inferred intent, write the mirror-image unit test (other entry moves the
opposite way) and ask what happens to a dirty editor. Related: [[state-change-navigation-bypasses-router-guard]].

Round 2 follow-up: the fix replaced inference with an explicit one-shot "yield" that unpins the card and re-sorts the
whole tail. That still misfires on an UP move when pinned leftovers already rank above the card (live inbox captures
in Clarify). An explicit signal must carry the direction (yield only on down/bottom), not just "a move happened".
