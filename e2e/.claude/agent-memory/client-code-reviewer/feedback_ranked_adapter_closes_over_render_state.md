---
name: ranked-adapter-closes-over-render-state
description: New useRankedRows adapters ignore the fresh `sectionRows` they are handed and plan from a render-time closure; queued keyboard commits then plan against pre-move state.
metadata:
  type: feedback
---

When a new list is put on the generic ranked machinery (`useRankedRows`), check what its `reorder` adapter plans against. The drag hook queues commits and captures `onCommit` at keypress time; only `sectionsRef` is guaranteed fresh when a queued commit runs.

**Why:** the item adapter is safe because it plans from the `sectionRows` argument (read through `sectionsRef`). The first non-item adapter (routines, Nov 2026) ignored that argument and planned from a `useCallback` closure over `allGroups`. A second press landing before the first refresh re-renders (Alt+Up then Alt+Down) compared against the stale order, so the "nothing moved" check matched and the move was dropped without a sound.

**How to apply:** for each new ranked adapter, ask "does the reorder callback read any React state other than its arguments?" If it does, ask for a ref updated in a layout effect, or a read from IDB at commit time. Also ask for a rapid back-and-forth e2e (Alt+Up then Alt+Down right away). A single-press test can never catch this.

Related: [[project_refresh_resolves_before_transition_commit]], [[feedback_stale_snapshot_fix_leaves_side_effects]].
