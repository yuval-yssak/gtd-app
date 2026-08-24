---
name: state-change-navigation-bypasses-router-guard
description: New in-app "navigation" implemented as a state change (wizard stage jump, step switch) silently discards ItemEditorBody structural edits — useUnsavedChangesGuard is useBlocker-based and only sees router navigations.
metadata:
  type: feedback
---

Any new control that moves the user away from a mounted `ItemEditorBody` (or `RoutineEditorBody`) by changing **component state** rather than performing a router navigation bypasses the unsaved-changes guard entirely. Structural edits (status chip, schedule, contexts, owner) persist only on explicit Save, so the edit is silently lost on one click.

**Why:** `useUnsavedChangesGuard` is built on TanStack Router's `useBlocker`. It intercepts router navigations and arms `beforeunload` — it has no visibility into a parent re-rendering a different child. In the weekly-review wizard this bit twice: `RevisitDecisionCard` had already discovered it and locks its item arrows on `api.isDirty || api.isSaving` with an explicit comment; the later stage-travel arrows shipped without the same lock and had to be caught in review.

Note the asymmetry that makes this easy to get wrong: **text** edits are safe (the `useAutosave` unmount flush commits them), **structural** edits are not. A lock that includes text edits is a false positive; one that omits structural edits is data loss.

**How to apply:** When reviewing a diff that adds any stage/step/panel switcher near an embedded editor, ask "is this a router navigation or a setState?" If setState, the control must lock while the editor is dirty, or prompt. Look for an existing sibling in the same feature that already solved it — the fix usually exists a file or two over with the rationale in a comment.

Watch for the lift being unavailable: a host often cannot read the editor's `api` outside `renderActions` without a render-phase setState. The accepted pattern here is a reactive `onDirtyLockChange?: (isLocked: boolean) => void` prop on the editor (effect-mirror of `isDirty || isSaving`, plus a cleanup effect resetting to `false` on unmount). **The unmount reset is load-bearing** — without it an editor unmounting while dirty strands the lock and permanently disables the control. Require a test that asserts the re-enabled state, not just the disabled one.

Related: [[feedback_free_navigation_invalidates_one_way_state]], [[project_editor_close_gestures_bypass_guard]], [[feedback_graceful_block_drops_bundled_edits]]
