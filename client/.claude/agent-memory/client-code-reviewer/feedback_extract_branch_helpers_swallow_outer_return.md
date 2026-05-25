---
name: extract-branch-helpers-swallow-outer-return
description: Refactors that pull early-return branches into inner async helpers can silently demote `return` from "exit the callback" to "exit the helper", letting the outer postlude (onSaved/onClose, cleanup, navigation) fire unexpectedly.
metadata:
  type: feedback
---

When extracting branches out of a `startSaving(async () => { ... })` / `startTransition(async () => {...})` callback into named inner helpers, a `return` that used to bail out of the *entire callback* becomes a return from *just the helper*. Anything written after the dispatch (`await onSaved(); onClose();`, navigation, refresh) will now run for the branch that intended to bail.

**Why:** Saw it in the RoutineEditorBody refactor — the reassign branch's `return` was demoted from "exit the startSaving callback" to "exit `runEditSave`", so `await onSaved(); onClose();` started running after the reassign was fired-and-forgotten. The double `onClose()` was harmless, but `onSaved()` now ran twice (once immediately, once when `runReassignWithOverlay().then(() => onSaved())` resolved) and on different IDB snapshots.

**How to apply:** When reviewing a dispatcher refactor that moved branches into inner helpers, always trace each branch back through the new outer postlude. If the original branch did `return;` immediately after fire-and-forget work, the refactor needs either a `boolean` return ("handled — caller should bail") or to keep that specific branch inline in the outer callback. Cross-check that the outer cleanup steps (onSaved, onClose, navigate, refresh) still happen exactly the same number of times per branch as before.
