---
name: reordered-list-breaks-persisted-ordinals
description: Reordering a canonical stage/step array is reviewed as "all consumers are id-keyed, safe" — but persisted ordinals (draft stageIndex) and in-range clamps mean mid-flight users silently resume on the swapped neighbour.
metadata:
  type: feedback
---

When a canonical ordered array (`REVIEW_STAGES`, wizard steps, tab lists) is REORDERED — not
lengthened — check every place its position was persisted as a NUMBER, not just the live consumers.

**Why:** The weekly-review stage swap (waitingFor before nextActions) was correct in every runtime
consumer, because `queues`, `skippedStageIds`, `isStageDone`, `stageIndexOf` and `?stage=` are all
id-keyed. The one ordinal was `StoredWeeklyReviewDraft.flow.stageIndex`. Its guard was
`Math.min(Math.max(i, 0), REVIEW_STAGES.length - 1)` — a LENGTH clamp, which no-ops for a pure
permutation since 3 and 4 are both in range. Anyone mid-review across the deploy resumes on the
wrong stage, with correct-looking queues and no error. `skipWaiting` + `clientsClaim` makes that the
expected path for open tabs, not an edge case.

**How to apply:** On any reorder diff, grep the persisted/draft/localStorage/URL shape for
`*Index`, `*Position`, `step`, `nth(` — an ordinal that crosses a deploy boundary. A clamp against
`.length` is NOT protection against a reorder; say so explicitly, because the clamp's comment
usually claims to handle "a build with a different stage list" and reads as already-covered. Fix is
to persist the id and resolve it on read (guard with the `isXId` predicate first — the
`indexOf`-style lookup returns -1, which reads as "before the first" downstream), keeping the
ordinal as a legacy fallback. Same check applies to e2e `.nth(N)` stepper/tab jumps: they silently
retarget on the next reorder, so demand a title assertion immediately after each one.

Related: [[feedback_shared_comparator_ties_destabilize_e2e_order]],
[[feedback_new_optional_queue_field_lost_by_replacing_reducers]]
