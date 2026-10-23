---
name: feedback_root_onkeydown_gets_portal_keys
description: A container-level React onKeyDown (editor root, list) also receives keys from portaled children — open Select menus, nested Dialogs — via React-tree bubbling.
metadata:
  type: feedback
---

A shortcut handler spread on a component root (`onKeyDown` on ItemEditorBody's Box) sees keydowns from every
React descendant, including portals: an open MUI `Select`/`TextField select` menu (letter type-ahead), and nested
modals rendered in the subtree (SendUpdatesDialog, UnsavedChangesDialog). `isEditableEventTarget` says "not a text
field" for a menu item, so bare-letter shortcuts fire behind the popup.

**Why:** 2026-10-23 editor status letters (`w`, `s`, `d`…) — typing to jump in the Calendar/Account/person select
flipped the item's status behind the open menu; letters/Cmd+Enter inside SendUpdatesDialog changed status or re-saved.

**How to apply:** for any new root-level key handler, ask "what portals render inside this subtree?" and demand a
DOM-containment / `role=menu|listbox|dialog` guard plus an e2e that types a letter into an open select.
Related: [[feedback_layout_key_mapping_by_code_breaks_punctuation]].
