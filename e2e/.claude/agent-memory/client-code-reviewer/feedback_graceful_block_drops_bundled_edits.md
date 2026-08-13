---
name: graceful-block-drops-bundled-edits
description: Adding a graceful offline/precondition block to a fire-and-forget mutation whose caller already closed the editor silently discards the edits bundled into that mutation.
metadata:
  type: feedback
---

When a "block gracefully instead of attempting" guard is added inside a fire-and-forget
mutation, check whether the *caller* closes its editor synchronously before the guard runs.
In this codebase the item/routine editors call `startReassignInBackground(...)` then
`closeEditor()` on the very next line, and reassign carries the whole save payload
(`editPatch` / `editRoutinePatch`) — title, status, contexts, schedule. A guard that returns
early therefore drops every structural edit, not just the ownership change, and the
unsaved-changes guard was already bypassed by `guardBypassRef`.

**Why:** the block was added at the innermost layer (provider / mutation helper) where the
label is available, but the "was anything actually attempted?" signal never propagates back
to the caller that already committed to closing. The failure is silent — a snackbar says the
move failed, and the user has no idea the rename went with it.

**How to apply:** on any review of a new early-return guard inside an async mutation, grep the
call sites for a synchronous close/navigate immediately after the call, and check what else
rides along in the request payload. Prefer hoisting the precondition check to the caller
(before it closes), or make the guard's return value something the caller must branch on.
Related: [[editor-close-gestures-bypass-guard]].

**Resolution pattern that worked here (2026-08-13 offline-reassign review):** guard at the
caller *before* it closes (surfacing via the editor's existing inline error slot) AND keep the
inner guard as defence-in-depth, plus change the fire-and-forget call to resolve a boolean the
caller gates its success postlude (`onSaved()`) on. Both layers are needed — the caller check
protects the edits, the inner check covers the network dropping between the two.

**Recurring sub-trap:** when hoisting such a guard into an editor, use the same reference the
downstream dispatch decision uses. RoutineEditorBody compares `routine` (mount-time prop) in
the new guard but `liveRoutineRef.current` in the dispatch — a remote owner change mid-edit
makes those disagree and the guard misses.
