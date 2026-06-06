---
name: withtimeout-string-simulated-tests
description: Claude-assist timeout tests reproduce the thrown message string instead of exercising withTimeout's timer; the budget + no-leak properties stay unverified.
metadata:
  type: project
---

`withTimeout(promise, ms, label)` in `src/lib/claude/tools.ts` bounds the one external tool (`getCalendarEvents`) under the 25s clarify budget. Its degrade test (`v1ClaudeAssist.test.ts`, "feeds a failed getCalendarEvents back as an error tool_result") simulates the timeout by `listEvents.mockRejectedValueOnce(new Error('getCalendarEvents timed out after 8000ms'))` — it reproduces the *message string* but never runs the real timer.

**Why:** the actual timeout value, the Promise.race ordering, and the `clearTimeout`-in-finally no-leak property are all load-bearing yet verified nowhere. Changing the ms, inverting the race, or dropping `clearTimeout` keeps the suite green. The thrown-string format is now coupled across two test sites with no test against `withTimeout`'s real output.

**How to apply:** when reviewing any new bounded/timed external call, demand a direct fake-timer unit test (`vi.useFakeTimers()` + `advanceTimersByTime`) asserting (a) rejection with the labelled message and (b) the timer is cleared on the success path. Flag string-only timeout simulation as a fidelity gap. Note also: Promise.race does NOT cancel the loser — listEvents runs to completion in the background; the AbortSignal-threading alternative would actually cancel it but is deferred. Related: [[project_lane_a_emergent_review_findings]] (missing 504 timeout test).
