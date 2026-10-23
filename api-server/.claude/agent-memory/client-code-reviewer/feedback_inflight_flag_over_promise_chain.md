---
name: inflight-flag-over-promise-chain
description: A boolean "isCommitting" ref guarding a serialised promise chain is cleared by the FIRST link's finally while later queued links still run
metadata:
  type: feedback
---

When a hook serialises async work through `chain = chain.then(...).finally(() => flag = false)`, a
boolean in-flight ref is reset as soon as the first queued link settles, though later links are
still pending. Recommend a pending counter (inc on enqueue, dec in finally) or comparing against the
current chain tail.

**Why:** Seen in the Next Actions drag hook (2026-10-23): the flag was meant to block new lifts
while any reorder was pending, but rapid queued commits re-opened the gate mid-queue. Authors test
the single-commit case only.

**How to apply:** Any time a review finds a ref flag + promise chain combo, trace two enqueues
back-to-back.
