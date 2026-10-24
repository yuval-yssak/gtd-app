---
name: feedback-chip-tone-applied-unselected
description: MUI chips switched color only while selected (`color={selected ? x : 'default'}`); porting to DS Chip often passes `tone` unconditionally, so unselected outline chips turn green/red.
metadata:
  type: feedback
---

When MUI `color={isSelected ? cfg.color : 'default'}` is migrated to the DS Chip, the port tends to write `tone={cfg.tone}` plus `selected={...}`. The DS Chip applies tone to the outline variant too (border + text), so the *unselected* Done/Trash status chips render green/red where MUI showed neutral grey. Seen in batch 3b (ItemEditorBody STATUS_CHIPS).

**Why:** the DS "selected fills in its tone" addition makes the selected state look right in stories, so nobody looks at the unselected row.

**How to apply:** On every MUI→DS chip/button port, compare the unselected state's colour to the MUI source's ternary; the fix is `tone={isSelected ? cfg.tone : undefined}`. Related: [[feedback-app-css-stylelint-claim-unverified]].
