---
name: inline-host-inherits-page-escape
description: When an editor body built for route hosts (Escape → raw onClose, relying on the router unsaved-changes guard) is mounted inline, Escape/Cancel become a setState that the guard never sees — silent discard of structural edits.
metadata:
  type: feedback
---

The item/routine editor bodies call `usePageEscapeToClose({ enabled: true, onEscape: onClose })` and justify the raw `onClose` with "the resulting router navigation stays behind the guard". That holds only when `onClose` navigates. Inline hosts (Weekly Review cards, Process Inbox wizard `advance`) pass a state flip, so Escape drops unsaved schedule/structural edits with no prompt, and keyboard focus falls to <body> when the host disables the button that opened the editor.

**Why:** seen in facelift batch 3 (2026-10-24) when RoutineDialog was replaced by an inline RoutineEditorBody in RoutineReviewCard. MUI Dialog behaved the same way, so it is parity rather than a regression, but the comment no longer describes every host.

**How to apply:** Whenever an editor body gets a new non-route host, check (1) what Escape/Cancel do with dirty structural state, (2) whether the comment justifying raw onClose is still true, and (3) where focus goes on open and close. Related: [[dialog-reset-effect-on-state-object-dep]].
