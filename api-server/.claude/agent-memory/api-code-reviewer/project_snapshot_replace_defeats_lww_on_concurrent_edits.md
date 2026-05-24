---
name: snapshot-replace-defeats-lww-on-concurrent-edits
description: Cascade/background-process helpers that build a snapshot in memory then call applyEntityOp (→ replaceById) with a fresh `updatedTs = now` will silently clobber any concurrent edit landing between the find and the replace. The LWW guard (`existing.updatedTs <= snapshot.updatedTs`) always succeeds.
metadata:
  type: project
---

Pattern (anti):
```ts
const items = await itemsDAO.findArray({...});      // (1) read
const ops = items.map(buildSnapshotOp);              // (2) construct, updatedTs = now
await applyAndPublishOperations(userId, ops, {...}); // (3) replaceById per snapshot
```

If a client/device write lands on the same item between (1) and (3), the cascade's snapshot is missing that write. The LWW guard in `applyEntitySnapshotOp` (`existing.updatedTs <= snapshot.updatedTs`) lets the cascade win because `now > existing.updatedTs`. The concurrent edit is lost.

**Why:** `applyEntityOp.replaceById` is a full-document upsert, not a field-level diff. The snapshot you build is the source of truth — so any divergence between the read and the replace is silently dropped. This is fundamental to the `OperationInterface` snapshot model.

**How to apply:** On any new cascade, backfill, or scheduled job that constructs a snapshot from a read + transformation, demand one of:
  1. A conditional `updateOne` with `$pull` / `$unset` / `$set` of just the changed fields, followed by `recordOperation` with the resulting snapshot (preferred — no read-then-write window at all).
  2. A per-item re-read inside the apply loop with `existing.updatedTs` checked against the read-time `updatedTs`, retrying or skipping on divergence.

Demand a regression test: "mutate field X between cascade find and apply; assert post-cascade has the concurrent edit, not the cascade's stale snapshot."

This pattern is wider than reference cascades. Watch for it on:
- Any "for each item, transform, write" loop in `lib/` that uses `applyAndPublishOperation(s)` rather than direct `updateOne`.
- Routine regeneration helpers that overwrite generated item state.
- Backfill scripts in `scripts/`.
