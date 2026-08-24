---
name: sibling-wizard-stages-duplicate-verbatim
description: ClarifyStage/FocusStage grow by copy-paste — each new cross-cutting stage feature lands as ~40 identical lines in both, with the comments copied too, so the drift is invisible in review
metadata:
  type: feedback
---

The weekly review's two solo-item stages (`ClarifyStage`, `FocusStage`) are structurally the same
component with different decision buttons. Every batch that adds a cross-cutting capability copies
the whole block into both: `savedRef` + `saveUndoSnapshotRef` + the decide-or-skip `onClose`,
`backOffset` + `useDecisionUndo` + the `RevisitDecisionCard` early return, the reassign-blocked
`StageNavButtons` fallback in the bar. The doc comments are copied verbatim too, which makes a
`diff` of the two files look intentional rather than duplicated.

**Why:** each feature reads as a small addition *within* one stage, so the 2-occurrence extraction
rule never trips during authoring. The stages were also written in separate batches.

**How to apply:** when reviewing any weeklyReview stage diff, `diff` the two stage files' preambles
directly — do not read them one at a time. Anything identical in both belongs in a shared hook
(the natural shape: a `useStageDecisionNavigation` returning the revisit node, the editor-close
handler, the snapshot capturer, and the nav-button props). The same tell applies to any future
`*Stage.tsx` added to the wizard. Related:
[[extracted-body-diverges-from-shared-chrome-type]].
