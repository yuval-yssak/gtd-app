---
name: shared-preview-fix-applied-to-one-host
description: Overflow/height caps for shared render components (MarkdownPreview) land on one host's wrapper class while the sibling hosts named in the same bug report stay uncapped
metadata:
  type: feedback
---

A height/overflow cap meant to fix "content pushes the action buttons out of reach" gets added to
the *one* wrapper class the reporter screenshotted (`.previewClickable`), while the other hosts of
the same shared renderer keep their own uncapped wrapper classes.

**Why:** `MarkdownPreview` has 4+ hosts, each with its own wrapper CSS module class
(`.previewClickable`, `.preview`, `RoutineReviewCard .notes`, `QuickCaptureFab .notesPreview`).
Only one composes the capped class, so "page-mode editors AND weekly review cards" bug reports get
half-fixed: the `chrome="page"` editors inherit the cap, but sibling cards that render
`MarkdownPreview` directly (not through `NotesSection`) do not.

**How to apply:** whenever a diff caps/scrolls a wrapper around a shared render component, grep
every import site of that component and check each host's wrapper class. If a host was named in the
bug report but its wrapper is a different class, that host is still broken. Same check applies to
the *behavioral* half (link/pointer carve-outs): a guard added in one host's event handler does not
protect click-to-edit surfaces in the others.

Related: [[feedback_inline_reimplementation_of_existing_sibling_component]],
[[feedback_affordance_relocation_leaves_third_copy]]
