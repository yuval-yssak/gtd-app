---
name: spend-cap-local-day-and-throw-path-gaps
description: Lane A spend.ts — BOTH original gaps (local-day key, throw-path metering) now FIXED; only remaining hole is a missing throw-path metering TEST
metadata:
  type: project
---

Lane A spend cap / COGS metering (`src/lib/claude/spend.ts` + `agentLoop.ts` + `routes/v1/claude.ts`, step e). The two original gaps are RESOLVED as of the step-e follow-up review (2026-06):

1. **UTC day-bucket — FIXED.** `spend.ts` now imports `dayjs/plugin/utc.js`, `dayjs.extend(utc)`, and `utcDay()` returns `dayjs.utc().format('YYYY-MM-DD')`. Tests compute the expected key with `dayjs.utc().format(...)` too, so they now genuinely assert UTC (no longer pass in lockstep with a local-time bug). Key is host-independent.

2. **Throw-path metering — FIXED.** `runClarifyLoop` now takes a caller-owned `usage` accumulator via `ClarifyParams` and mutates it in place (`accumulateUsage(into, …)` does `into.x += …`, never reassigns). It returns just `ClarifyProposal`. The handler builds `const usage = emptyUsage()`, passes it in, and calls `recordUsage(ownerUserId, usage)` in a `finally` — so spend is metered on success, summary-only fallback, timeout (504), AND agent_error (502). Cap check (`isOverDailyCap`) still returns 402 BEFORE the try/finally, so a capped request that never ran the loop is correctly NOT metered (no double-metering). `recordUsage` is best-effort (`.catch` logs); awaiting it in `finally` can't alter the already-returned Response because `finally` has no `return`.

**REMAINING GAP (test coverage, not behavior):** there is still NO test that drives a model-call THROW (502/504) and then asserts a `claudeUsage` row exists with the partially-accumulated tokens. The `metering-failure-still-200` test only proves the `.catch` best-effort wiring; the exact-cost and two-call-accumulation tests only cover success paths. The throw-path metering — the entire motivation for fix #2, and the highest-token-cost case — is unverified.
**How to apply:** on any further spend/metering review, require a test that mocks `messagesCreate.mockRejectedValueOnce` (or aborts via the timeout) AFTER one scripted tool turn, asserts 502/504, and then asserts the `claudeUsage` row holds the tokens from the first turn. Until that exists, the regression that fix #2 closed can silently reopen.

Related: [[resolve-calendar-context-no-degrade]] (same feature). [[lane-a-claude-assist-staged-rollout]].
