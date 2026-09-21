---
name: ref-mirror-stale-same-tick-commit
description: Editor commit handlers that read form state via a render-assigned ref mirror go stale when a control mutates state and commits in the SAME tick (clear buttons, reset affordances)
metadata:
  type: project
---

Item/routine editors mirror form state into refs with a bare render-time assignment
(`formRefs.current = { title, notes, brief, ... }`). Commit callbacks then read
`formRefs.current.X`. That is correct for blur/Enter — React has already re-rendered, so the
mirror is current — but **wrong for any control that calls `onChange(next)` and commits in the
same tick**, because the mirror is only refreshed on the next render. The commit then decides
against the OLD value and typically resolves to `noop`, so the UI shows the new value while
nothing is persisted.

**Why:** hit twice in the item-brief feature (2026-09). The clear (x) adornment on `BriefSection`
did `onChange(''); onCommit();` — the field blanked but the row survived until the unmount flush.
Unit tests could not see it (no DOM infra); only Playwright caught it. The sibling defect was a
seed-rebaseline race where the *seed* half of the comparison was stale until an async round-trip.

**How to apply:** when reviewing an editor commit path, check each trigger separately — blur,
Enter, and any same-tick mutate-and-commit affordance (clear/reset/revert buttons, chip deletes).
If one exists, the committed value must travel as a call argument (`onCommit(value)`), not be read
from a ref. Ref reads remain correct in unmount cleanups, where no render-scoped value exists.
`ManageInboxesDialog`'s `RenameField` already uses the value-passing convention — cite it as the
in-repo precedent. Related: [[project_live_merge_reset_drops_burst_baseline]],
[[project_no_dom_hook_test_gap]].
