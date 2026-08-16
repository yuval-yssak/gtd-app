---
name: count-label-scope-narrowing
description: Narrowing what a header/tab count includes (excluding paused, archived, filtered-out rows) re-implements the exclusion predicate inline instead of reusing the existing splitter, and leaves a "(0) over a non-empty page" state
metadata:
  type: feedback
---

When a count in a tab/header label is narrowed to a subset (active-only, unarchived-only), the
diff filters inline (`filtered.filter((r) => r.active)`) even though a named helper that already
encodes that exact predicate exists and is used a few lines below (`splitActivePaused`). The
predicate then lives in two places and can drift.

Two follow-on things the diff usually misses:
- **The paired count.** These counts often come in pairs where the second is derived by
  subtraction (`total - first`). Narrowing the numerator changes both, but only the first gets a
  test assertion.
- **The `(0)`-over-content state.** Excluding a category from the count means a tab can read `(0)`
  while the page below still renders that category's own section. Check the label is not the only
  signal of content, and that whatever renders below has an explicit test.

**Why:** the count expression and the section-rendering split sit ~3 lines apart but are written
at different times, so the duplication is invisible unless both are read together. Same failure
shape as chrome gates drifting from their sibling gates.

**How to apply:** on any diff changing what a count includes — grep for an existing helper
encoding the same predicate before accepting an inline filter; check the sibling/derived count is
asserted too; ask what the label reads when the excluded category is the *only* content.

Related: [[new-list-chrome-skips-empty-gate]], [[conditional-render-gate-loses-coverage]]
