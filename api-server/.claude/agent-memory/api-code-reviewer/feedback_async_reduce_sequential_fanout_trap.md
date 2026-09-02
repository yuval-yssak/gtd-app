---
name: async-reduce-sequential-fanout-trap
description: A "sequential" async reduce that awaits the work BEFORE `await accumulated` fans every iteration out in one tick; tests using `.sort()` on the call order cannot see it. Demand a deferred-resolver ordering test and prove with a start/end log.
metadata:
  type: feedback
---

Any `arr.reduce(async (acc, x) => { const r = await work(x); return [...(await acc), r]; }, Promise.resolve([]))` refactor of a `for…of + await` loop is NOT sequential — `Array.prototype.reduce` invokes every callback synchronously, so every `work(x)` starts in the same tick and only the RESULT ORDER is preserved. Sequential form must `await acc` first, then call `work(x)`.

**Why:** Round-3 review of the split-chain sync-doctor check (2026-09-02) found `findSplitChainFindings` refactored from a loop to exactly this shape, with a docstring and inline comment both still claiming "Sequential on purpose (Google round-trip cost)". A tsx probe logged `start a | start b | start c | end a | end b | end c`. The existing test asserted `resolvedIds.sort()` — order-blind — so the suite stayed green. This is the same class as [[fire-and-forget-cascade-assertions-need-waitfor]]: a comment asserting timing that the test never exercises.

**How to apply:** Whenever a review claims a loop→reduce/flatMap refactor "didn't change behavior" and the loop's reason for existing was rate-limiting/ordering of external calls: (1) read where the `await acc` sits relative to the work call; (2) if in doubt, run a 10-line probe with a deferred resolver and a start/end log; (3) require a discriminating test — a resolver whose second invocation asserts the first has already resolved (or a `vi.fn` that throws if called while another is in flight). `.sort()` on recorded ids in a test is a red flag when the code claims sequencing.

**Validated test shape (round 4, 2026-09-02):** an `inFlight`/`maxInFlight` counter pair inside a `setTimeout(10ms)`-deferred resolver over 3 rows, asserting `maxInFlight === 1`. Revert-probed by swapping the two await lines: that single test fails with `expected 3 to be 1`, nothing else in the file moves. Cheap (~30ms, real timers), no fake-timer plumbing needed — prefer this over the throw-if-concurrent variant because the failure message reports the actual fan-out width.
