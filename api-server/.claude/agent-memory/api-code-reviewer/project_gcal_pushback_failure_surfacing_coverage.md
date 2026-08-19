---
name: gcal-pushback-failure-surfacing-coverage
description: "Every maybePushToGCal branch must funnel through captureFailedOutcome → surfacePushFailure; only create paths used to, so mutation-only pushes (cancellation/override/pause/delete/detach) dropped failures into notifyChange's console-only catch"
metadata:
  type: project
---

`maybePushToGCal` is invoked fire-and-forget from `notifyChange` with only a `.catch(console.error)`.
Any push helper that *throws* instead of returning a `{status:'failed'}` `PushOutcome` is therefore
invisible: no `syncFailed` op, no SyncIssuesPanel row, no retry. Historically only the two CREATE
paths (`pushNewItemToGCal`, `pushNewRoutineToGCal`) minted outcomes; every mutation-only branch
(instance cancellation, instance override, existing-item update, pause cap, resume series push,
existing-routine update, routine deletion, hard-delete cleanup, detach removal) swallowed or threw.

**Why:** production incident 2026-08-19 — a 9-item burst-trash of a daily routine hit Google's
short-window per-user write quota on 2 of 9 instance-cancellation PATCHes. Both vanished into the
console; Google stayed stale with no user-visible signal and nothing to retry.

**How to apply:** when reviewing a NEW branch added to `maybePushToGCal` / `handleItemPush` /
`handleRoutinePush`, verify it returns through `captureFailedOutcome` and that its caller reaches
`surfacePushFailure`. A branch that `await`s a helper and then bare-`return`s is the regression
shape. Two adjacent facts worth re-checking rather than assuming:
- Ops reaching `maybePushToGCal` are always already persisted (`recordOperation` inserts
  unconditionally; `applyOperation` hydrates `snapshot`/`detachedCalendar` in place BEFORE
  `insertOne`/`insertMany`), so panel Retry re-fires with a complete op. Verify this still holds if
  the insert/hydrate order ever moves.
- Regeneration/cascade helpers (`routineItemRegeneration`, `calendarItemNotes`) call
  `recordOperation` WITHOUT `notifyChange`, so they never reach pushback — the surfacing blast
  radius stays bounded to ops that already pushed. A new `notifyChange` call in those files would
  widen it.

One residual escape hatch, deliberately left: `pushRoutineResume` awaits
`regenerateFutureRoutineItems` OUTSIDE any capture, so a Mongo failure there still escapes
unsurfaced. That is correct — it is not a GCal error and `categorizeGCalError` would mislabel it.

Related: [[project_gcal_403_rate_limit_is_retryable]],
[[feedback_fire_and_forget_cascade_assertions_need_waitfor]].
