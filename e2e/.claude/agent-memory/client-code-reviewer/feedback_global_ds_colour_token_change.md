---
name: global-ds-colour-token-change
description: How to review a DS colour retune (new semantic token swapped into IconButton/nav defaults) — what to check, what not to demand
metadata:
  type: feedback
---

A "one-line colour change" request (e.g. resting icon buttons/menu items read as disabled) is legitimately solved by a new semantic token in tokens/variables.css (light + dark) swapped into the DS default, not per-call-site overrides. Approved 2026-11-06 (`--color-text-control`).

**Why:** designSystem/CLAUDE.md has no token catalog/story requirement — stories are per component state. Demanding a token story or docs entry is noise.

**How to apply:** check instead (1) both theme blocks define the token, (2) unlayered app className overrides that pin `color` on an IconButton (they silently stay on the old colour), (3) disabled (opacity 0.4) still reads distinct from rest, (4) hover rules still reach a brighter step. Pre-existing: IconButton's `[data-tone="neutral"]:hover` sits outside `@media (hover: hover)` (sticky on touch) — not new, don't flag as a regression of the colour change. Related: [[e2e-asserts-textcontent-for-visual-bug]] — a computed-colour e2e is the right proof here.
