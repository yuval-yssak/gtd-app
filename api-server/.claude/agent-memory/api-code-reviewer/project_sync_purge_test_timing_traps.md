---
name: /sync/* fire-and-forget purge tests are timing-trap prone
description: Tests asserting "op survives" after a /sync/pull that triggers fire-and-forget purgeOldOperations can pass spuriously on a short tick() — even pre-fix code would pass if the purge hasn't fired yet. Demand positive-signal patterns.
type: project
---

`/sync/pull` triggers `purgeOldOperations(user.id).catch(() => {})` fire-and-forget. Tests that assert "this op should NOT be purged" by doing a fixed `tick()` (5-10ms) and then `countDocuments === 1` are racy in the wrong direction: if the purge hasn't fired yet, the assertion passes regardless of the code under test. Any regression that re-introduces the LinkedIn-inbox bug could ship green.

**Why:** Reviewed the explicit-ack cursor protocol PR (2026-05-11). The new "lost-response retry" test in `sync.test.ts` waits 10ms after a pull and asserts the op survives — but pre-fix code would also pass that timing window most of the time. The test proves the fix only via lucky scheduling.

**How to apply:** For any /sync/pull purge-related test, require a positive signal that the purge cycle ran:
  - Seed a **canary op** that the floor *does* permit purging (e.g., a separate device with high lastSyncedTs).
  - Use `waitForPurge(() => canary is gone)` to confirm the cycle completed.
  - THEN assert the protected op still exists.
Pattern lives in `sync.test.ts` already (`waitForPurge`); the trap is that "this op survives" tests don't use it because they have no convergence signal of their own.

Flag on review: any new purge-survival test that ends with `await tick(); expect(...countDocuments...).toBe(N)` without a canary.
