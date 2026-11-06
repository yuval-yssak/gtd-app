---
name: stampsnapshot-not-universal
description: "Every write funnels through stampSnapshot" is false for inbound GCal — updateRoutineFromGCal and other calendar.ts writes use replaceById + recordOperation, bypassing applyOperation
metadata:
  type: project
---

Invariants placed in `stampSnapshot` (applyOperation.ts) cover app /sync/push, /v1 and MCP only. Inbound Google sync writes (`updateRoutineFromGCal`, `reconcileAndApplyRoutineExceptions`, item reconcilers) persist via `routinesDAO.replaceById` / `replaceRoutineGuardingActiveSlot` + `recordOperation` and never see it. Seen 2026-11-06 on fix/prune-past-end-exceptions: the Google-side cap (`newlyGainsUntil`) also flips `active:false`, and exception sync filters `active: {$ne:false}`, so neither prune site ran for a GCal-capped routine — exactly the prod incident shape.

**Why:** authors claim "the one place every write path funnels through" from the comment in stampSnapshot.

**How to apply:** when a change puts a data invariant in stampSnapshot, trace the GCal inbound path that *causes* the condition (cap, rrule change, delete) and check it enforces the invariant too. Also: per-element `isPastSeriesEnd` calls re-expand COUNT rules each time (measured 1.3s for 100 exceptions on COUNT=5000) — hoist end computation. Related: [[gcal-owned-field-addition-checklist]].
