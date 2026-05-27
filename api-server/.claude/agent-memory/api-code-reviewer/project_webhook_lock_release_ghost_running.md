---
name: webhook-lock-release-ghost-running
description: Calling finishWebhookSync from the runWebhookSync catch path can leave channelStates in a ghost 'running' state if a re-run was queued during the throwing sync, silently dropping the next delivery.
metadata:
  type: project
---

In `calendar.ts` `runWebhookSyncLoop`, the error path calls `finishWebhookSync(channelId)` to release the in-memory lock when `runWebhookSync` throws. `finishWebhookSync` returns whether a re-run was queued AND, if so, leaves `channelStates` set to `'running'` (line ~3225) for the loop to consume. The catch path discards that return value, so when a queued delivery arrived during the throwing sync, the channel is left in `'running'` with no actual runner.

Effect: the next genuine webhook delivery hits `tryStartWebhookSync`, sees `'running'`, coalesces into `'queued'`, and does NOT start a sync. Only the delivery *after that* actually starts one. The comment ("the next genuine webhook delivery will retry once the lock is free") overstates the cleanup.

**Why:** `finishWebhookSync` is engineered for the loop's continuation contract, not for hard cancellation. Reusing it in the catch path borrows a return-value semantics the catch can't honor (it's already throwing out of the loop).

**How to apply:** when reviewing lock-release on error in `runWebhookSyncLoop` or similar coalescers, demand either (a) `channelStates.delete(channelId)` direct-clear in the catch, or (b) drain via `while (finishWebhookSync(channelId)) {}`. Also flag missing test coverage for the "throw while a re-run is queued" interleaving — the current regression test only covers the lone-runner case.
