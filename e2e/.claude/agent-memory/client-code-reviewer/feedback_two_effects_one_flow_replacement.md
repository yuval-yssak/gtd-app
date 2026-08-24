---
name: two-effects-one-flow-replacement
description: When a parent and a child effect both commit whole-object state through the same value-taking `onXChange` callback, they fire on the same dependency change and the parent silently clobbers the child — the weekly review's deferred requeue vs. the wizard's reconcile
metadata:
  type: feedback
---

The weekly review holds its entire wizard state in one `ReviewFlowState` object, committed via
`onFlowChange(flow)` → `setPhase({ kind: 'active', flow })` — a plain replacement over a
render-captured `flow`, never a functional updater. Two different effects write through it:

- `WeeklyReviewWizard`'s reconcile effect (parent), deps include `items`
- `useDecisionUndo`'s deferred phase-2 requeue (child, inside the stage), deps include `allItems`

React runs child effects before parent effects, so a single `items` identity change schedules both
in one commit, **both derived from the same stale render**. The parent's write lands last and drops
whatever the child just committed. In the undo case that means the requeued id is in neither
`pending` nor `decisions` while its data *is* restored in IDB — the exact "vanishes with no trace"
symptom of [[deferred-requeue-dies-with-host-unmount]], reached through a different door. The child
had already run `setAwaitedRequeue(null)` unconditionally, so nothing retries.

**Why:** the unmount fix and the reconcile predate each other and were each reasoned about in
isolation. Neither author asked "who else writes `flow` on this same dependency?" — the value-taking
callback signature makes the collision invisible at both call sites.

**How to apply:** whenever a diff adds a second effect that commits through an existing
whole-object `onXChange(value)` setter, list every other writer and check their effect
dependencies for overlap. Overlap + value-replacement = lost update. Push the composition into a
functional updater (`onXChange(prev => ...)`) rather than trying to order the effects; the pure
helpers here (`requeueAtHead`, `reconcileQueue`) are already idempotent and compose correctly once
they see the latest state. Pin it with a pure test that applies both transforms in sequence.
Related: [[free-navigation-invalidates-one-way-state]].

**Resolution shape that worked** (weekly review, round 3 — reusable for the next occurrence): a
`latestFlowRef` at the owning route as the resolution base for updaters (set synchronously in the
commit fn, cleared on every exit from the active phase), the child hook stops taking `queue` as a
prop **at all** so there is no stale copy it could use, and the consumer prop type is narrowed to
updater-only (`(update: ReviewFlowUpdater) => void`) so the compiler rejects a future value-form
regression. The parent's render-time "did anything change?" gate can stay, as long as the value it
commits is RECOMPUTED inside the updater.
