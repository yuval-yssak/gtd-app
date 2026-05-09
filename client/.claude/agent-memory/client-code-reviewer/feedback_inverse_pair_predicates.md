---
name: Inverse-pair predicates
description: Two near-mirror predicates of the same underlying truth ship as a pair; prefer one canonical predicate and invert at the call site.
type: feedback
---

When the diff introduces two predicates that turn out to be exact inverses of one trim/length check (e.g. `xShouldStartEditing(s)` returning `!s.trim()` and `xShouldExitEditOnBlur(s)` returning `s.trim().length > 0`), suggest collapsing to one canonical predicate (`xHasContent(s)`) and letting the call site invert.

**Why:** Two predicates double the test surface for one truth and let them silently diverge (e.g. one updated to handle `null`, the other not). Asymmetric naming also obscures the underlying invariant.

**How to apply:** When reviewing newly-extracted helper pairs in `editItemDialogLogic.ts` or similar, look for inverse-of-each-other implementations. Recommend a single name that conveys the underlying truth.
