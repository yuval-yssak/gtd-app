---
name: blur-exit-unmounts-tab-target
description: Pencil/edit-mode toggles that exit on blur unmount the field's own sibling controls (Done, Clear) the instant Tab reaches them; keyboard focus falls to body and those buttons are unreachable.
metadata:
  type: feedback
---

When a view/edit toggle commits + flips back to the read view in the field's `onBlur`, Tab from the field lands on a sibling control (Done check, Clear adornment) that the flip immediately unmounts — focus drops to `document.body`, and the explicit Done button can never be reached by keyboard. Mouse paths work (they use `onMouseDown preventDefault`), and e2e only clicks, so nothing catches it.

**Why:** Seen in the BriefSection pencil rework (2026-10-21); NotesSection avoids it with `onBlurOutside`. The author tested Escape/Enter/Done-click focus return but not Tab.

**How to apply:** For any blur-to-exit editor, ask: where does Tab from the field go, and is that element still mounted after the blur commit? Demand a focusout-on-wrapper check (`currentTarget.contains(relatedTarget)`) and an e2e that Tabs to Done and presses Enter. Related: [[click-to-edit-a11y]].
