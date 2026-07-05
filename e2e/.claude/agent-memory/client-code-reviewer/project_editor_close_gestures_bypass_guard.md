---
name: editor-close-gestures-bypass-guard
description: The item/routine editor unsaved-changes guard only covers router navigation; several close gestures route around it
metadata:
  type: project
---

The unsaved-changes navigation guard (`useUnsavedChangesGuard` + `guardBypassRef` + `closeEditor()`) in `ItemEditorBody`/`RoutineEditorBody` only intercepts **router navigation** (via TanStack `useBlocker`). It does NOT cover dialog dismissal.

**Why:** in dialog/popover/expand chrome the editor is wrapped by a MUI `<Dialog onClose={onClose}>` (see `EditItemDialog`, `RoutineDialog`). Backdrop click and Escape call the wrapper's `onClose` **directly**, never `closeEditor()`, so `guardBypassRef` is never set — but since dialog dismissal isn't a router navigation, the blocker also doesn't fire. Net effect: a structural edit made in a dialog-chrome editor can be dropped silently by backdrop/Escape with no prompt. Only the page-chrome routes (`item.$itemId`, `routine.$routineId`) and sidebar links get guard coverage, because their close is a real navigation.

**How to apply:** when reviewing changes to these editors or their wrappers, check whether a new close/dismiss gesture goes through `closeEditor()` (bypasses guard deliberately) vs. the wrapper `onClose` (no guard at all). If reviewers/PM want dialog-chrome protection too, the guard needs an intercept on the MUI Dialog `onClose`, not just `useBlocker`. Also note `ownerUserId` is seeded from the initial `item.userId`, not `liveItem` — a remote reassign while open can make `hasStructuralEdits()` a false positive.
