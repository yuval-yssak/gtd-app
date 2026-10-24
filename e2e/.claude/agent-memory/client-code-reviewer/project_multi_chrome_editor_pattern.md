---
name: Editors are pages (multi-chrome pattern retired)
description: The item and routine editors are always pages since the Base UI facelift (batch 3); the dialog/popover/expand/instant chromes and the "Item editor" setting were removed.
type: project
---

The old "multi-chrome editor" shape (Body + Expand + Popover + Dialog wrappers, a `useXEditor` host
hook resolving the variant from `localStorage['gtd:inlineClarifyMode']`) was **removed** in the Base UI
facelift, batch 3 (decided by the user, Oct 2026):

- `ItemEditorBody` / `RoutineEditorBody` take no `chrome` prop. Their hosts are the item page
  (`/item/:id`), the routine pages (`/routine/new`, `/routine/:id`), the Process Inbox wizard
  (`/process-inbox`) and the Weekly Review cards (inline, a card — not an editor mode).
- `useItemEditor()` / `useRoutineEditor()` only navigate (in place, or a new tab on cmd/ctrl+click)
  and own the fromGmail read-only toast. There is no Settings choice; a stale stored mode is ignored.
- `PersonEditorBody` keeps `chrome: 'dialog' | 'page'` — "Add/Edit person" is a short centred dialog.

**Why:** the user wanted one editing surface everywhere ("everything in full screen always").

**How to apply:** flag any reintroduction of an editor dialog/popover/inline-expand for items or
routines, or of a mode setting. A new entity editor should be a page plus, for short forms only, a
centred DS Dialog.
