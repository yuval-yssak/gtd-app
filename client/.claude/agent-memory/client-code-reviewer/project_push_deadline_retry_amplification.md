---
name: push-deadline-retry-amplification
description: Client deadlines on sync requests whose payload is unbounded — push (apply-and-retry loop) and pull/bootstrap (never-catch-up livelock); check size is bounded or the deadline covers headers only.
metadata:
  type: project
---

/sync/push has no request-level idempotency key: queued ops carry only a local autoincrement id, so a retried batch inserts fresh op rows and re-fans-out (and re-replays RSVPs, which are awaited in-request). A client abort does not stop the server from applying.

**Why:** 2026-10-03 review of the flush Web Lock fix added `AbortSignal.timeout(30s)` to pushSyncOps while readQueuedOpsForFlush sends the whole queue in one batch. If the server is slow (Atlas M0 throttling has hit ~90 KB/s before, Cloud Run cold start), every retry aborts at 30s after the server already applied the batch, so the queue never drains and the op log bloats.

**How to apply:** when a change adds a timeout/abort to a mutating sync request, check that the batch is chunked (or the deadline is generous), and treat "the retry is the same as a failed response" as true for the client only, not for server op-log growth. Related: [[node-env-tests-hit-real-localhost]].


**Pull side (2026-11-16, lie-fi review):** `/sync/pull` is also unpaginated (`findOpsAfter` has no limit) and the deadline signal covers the body read, so a whole-request 30s deadline on a long-offline device's catch-up over a slow link aborts every attempt at the same range — idempotent, but the device never syncs. Ask for a time-to-headers deadline (clear the timer once `fetch` resolves) or server pagination.
