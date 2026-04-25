---
name: Use (ts, _id) lex order to identify "the prior op" in pushback history scans
description: Pattern-level feedback — when pushback code scans the ops collection for "the prior op", filter by strict (ts, _id) lex-less than current; `_id: {$ne}` alone is insufficient
type: feedback
---

When server-side pushback code (e.g. `calendarPushback.ts`) needs to distinguish the "current op being pushed back" from "prior ops" by scanning the operations collection, filter for ops strictly before the current op in `(ts, _id)` lex order — not just excluding the current `_id`.

**Why:** Two observed failures in pushback history scans:
1. Filtering by `snap.updatedTs !== currentUpdatedTs` drops both ops when two devices push in the same wall-clock second — transition detection (pause/resume) breaks silently.
2. Filtering by `_id: {$ne: currentOpId}` alone fails when the SAME device ships two consecutive pause ops (e.g. from two flush batches milliseconds apart). Each op excludes itself, then finds THE OTHER pause op as "prior" — both see `priorActive=false` → both skip the cap → GCal master never gets UNTIL (I7 live bug, 2026-04-24).

Using the composite predicate `{ $or: [{ ts: {$lt: currentTs} }, { ts: currentTs, _id: {$lt: currentOpId} }] }` with `sort({ts:-1, _id:-1}).limit(1)` makes "prior" deterministic:
- Different-`ts` ops: newer always sees older → correct transition detection.
- Same-`ts` ops (two-device collision): the lex-greater `_id` is "current", the lex-smaller is "prior" → exactly one side fires the transition.

**How to apply:** In reviews of any helper that reads `operationsDAO.findArray` to reconstruct prior state, flag:
- Any filter using snapshot fields (`updatedTs`, `createdTs`) to identify "current" op — switch to server-assigned `op._id`.
- Any filter using only `_id: {$ne}` when the code is called per-op from a fire-and-forget `Promise.all` (sync-push fans out one `maybePushToGCal` per op). Require the strictly-before `(ts, _id)` composite.
- Tests must cover BOTH: same-`ts` two-device collision AND back-to-back same-device ops with distinct `ts`. Both are real production scenarios.
