---
name: feedback-suspense-boundary-move-strands-comments
description: Adding/moving a Suspense boundary leaves neighbouring boundary comments (inner route boundary, main.tsx boot boundary) claiming they catch suspends that now land elsewhere
metadata:
  type: feedback
---

When a Suspense boundary is inserted or moved in `_authenticated.tsx` / `main.tsx`, the existing comments on the *other* boundaries keep describing which `use()` they catch. Check which component actually calls `use()` (e.g. `AppDataInner` sits ABOVE the inner route `<Suspense>`) and re-derive every boundary's comment. Also note React 19.3 hides portals under a re-suspended boundary (`hideOrUnhideNearestPortals`), so open dialogs inside it are hidden, not just in-flow content; state and DOM survive.

**Why:** the stale comment is the only documentation of a load-bearing nesting order; the next reader moves things based on it.
**How to apply:** for any Suspense diff, list each boundary and what suspends into it, then compare with every comment. Related: [[feedback-spec-header-comment-outlives-inline-edits]].
