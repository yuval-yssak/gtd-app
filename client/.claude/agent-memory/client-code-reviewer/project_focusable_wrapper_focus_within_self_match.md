---
name: focusable-wrapper-focus-within-self-match
description: Making a wrapper focusable (tabIndex=-1 parking spot) makes its own `:focus-within` "editing" style match when the wrapper itself is focused, so parked looks identical to editing.
metadata:
  type: project
---

`:focus-within` matches the element itself. A wrapper that styled "child is being edited" with `:focus-within` (e.g. the notes editor `.editor`) shows the same accent ring once the wrapper itself takes focus.

**Why:** seen 2026-11-20. The Escape-parks-on-field-box change made the notes container a parking spot. Parked looked like editing while letter keys had become live shortcuts (editor status letters).

**How to apply:** whenever a diff adds tabIndex to a container, grep its CSS for `:focus-within` and demand a distinct `:focus-visible` (focus-ring token) state plus a story. Also check `[tabindex]`-based "canFocus" predicates (useTransitionFocusRestore domLookup) that the new focusable now satisfies. Related: [[key-semantics-change-stale-legend]].
