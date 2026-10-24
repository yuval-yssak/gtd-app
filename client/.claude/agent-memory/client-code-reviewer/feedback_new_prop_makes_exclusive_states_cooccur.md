---
name: new-prop-makes-exclusive-states-cooccur
description: A DS prop that lets two formerly mutually-exclusive data-attribute states co-occur (StepIndicator isComplete → data-active + data-complete) hits a same-specificity rule-order collision the CSS was never written for.
metadata:
  type: feedback
---

When a DS change adds an override prop (e.g. StepIndicator `isComplete`), check whether two data-attr
states that used to be exclusive by construction (positional `index < activeIndex` vs `index === activeIndex`)
can now both be set. Same-specificity rules then resolve by source order and silently mix: in batch 6
the active marker kept the accent fill from `[data-active]` but took `color: accent` from `[data-complete]`,
so the step number vanished — the common case in the weekly review (current stage empty = done).

**Why:** the unit test asserted attributes only and the story never rendered the co-occurring state; a
computed-style probe in Storybook (Playwright against `storybook dev`) proved it in a minute.

**How to apply:** for any new override/escape-hatch prop on a DS component, enumerate the newly reachable
attribute combinations, demand a story for each and an explicit CSS rule for the combination. Related:
[[revert-check-regression-tests]] — attribute-only tests do not pin visuals.

Same batch, separate parity trap: MUI Snackbar's content is `role="alert"`; DS Toast defaults to the polite
`role="status"` region. Error toasts migrated without `tone="error"` lose the assertive announcement.
