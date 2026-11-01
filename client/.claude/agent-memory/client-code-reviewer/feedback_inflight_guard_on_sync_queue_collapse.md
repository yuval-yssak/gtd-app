---
name: feedback-inflight-guard-on-sync-queue-collapse
description: In-flight/"already sent" guards added to queueSyncOp collapse rules miss the merge branch (re-ids the op), ambiguous push failures, and the await gap before marking; never prescribe "plain update after an attempted create"
metadata:
  type: feedback
---
When a fix teaches `queueSyncOp`'s delete-collapse to respect a create the flush has already sent (an in-memory id set marked in `pushBatch`), three holes keep showing up:
1. `mergeUpdateIntoCreate` deletes the in-flight create and re-adds it under a NEW id, so create → (push starts) → update → delete still collapses and resurrects the row. The fix is for the merged row to INHERIT the mark. Do NOT prescribe "queue a plain update instead". I prescribed that once and it broke 3 e2e specs: the server applies a create as an LWW upsert but quarantines an update for a row it does not hold (`skipped_missing`), and a create + update pushed in the same batch lost the update in the offline flow. Re-pushing a merged create is the safe direction.
2. Clearing the mark when a push fails assumes the server never got the op. That is false for a timeout or a connection dropped after the server committed. Clear the mark only when the op leaves the queue.
3. Marking after `await getOrCreateDeviceId` leaves an IDB-await window after the batch has been read.

**Why:** found while reviewing the 2026-11-01 weekly-review resurrection fix (create something, delete it within a second, and it comes back on the next pull). Point 1's correction came from the coordinator's bisect of the e2e failures.
**How to apply:** for any change to sync-queue collapse that keys on per-op state, trace every branch that deletes or re-adds queue rows, and every way pushSyncOps can fail. Before recommending a different op type, check how the server applies it to a row it does not hold yet. Related: [[feedback-deferred-side-effect-lost-on-loop-throw]].
