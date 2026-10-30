---
name: feedback-testid-sweep-group-not-option
description: Testid sweeps stamp the ToggleGroup/RadioGroup/Tabs root and leave the option segments (the real controls) unaddressable; also repeated chips missing the instance attribute
metadata:
  type: feedback
---

Bulk `data-testid` sweeps put the id on the closed-widget root (`<ToggleGroup data-testid="energyToggle">`, RadioGroup, Tabs) — which is the group/tablist, not a clickable control — while the options array (`ENERGY_OPTIONS`, `NOTES_TABS`, radio `*_OPTIONS`) stays bare. Precedent in the same codebase puts per-option `'data-testid'` in the options array (routines `VIEW_OPTIONS`, waiting-for `SORT_OPTIONS`, `RECURRENCE_ANCHOR_OPTIONS`).

**Why:** the DS widgets have closed prop sets, so an option can only be targeted via its own `data-testid` entry; a group id alone forces tests back to role+text.

**How to apply:** for every group-level id in a sweep diff, open the options constant and check each entry. Also check repeated primitives (quick-pick chips, TOC links) got an instance `data-*` beside the shared id. For e2e locator helpers keyed by string ids, ask for the client union type — a typo inside `filter({ has })` + `.not.toHaveAttribute` passes vacuously.
