---
name: calendar-test-local-startofday-tz-fragility
description: calendar.test.ts fixtures built from dayjs().startOf('day') are runner-TZ+wall-clock fragile against the Asia/Jerusalem config cutoff; the past-event branch masks the failure for update-path tests
metadata:
  type: project
---

`calendar.test.ts` fixtures that anchor event times to `dayjs().startOf('day').add(Nh)` are fragile:
that is the **runner's local** midnight, but the production past-event cutoff
(`startOfTodayInTz` → `isPastEvent`, compares `timeEnd`) uses the **sync config's** timezone, and the
shared `makeSyncConfig` helper hardcodes `timeZone: 'Asia/Jerusalem'` (NOT UTC — a recurring
misdiagnosis). So on a UTC runner at wall-clock 21:00Z–23:59Z, Jerusalem has already rolled to
tomorrow and the cutoff jumps forward ~21h, silently reclassifying "earlier today" fixtures as past.

**Why:** CI (UTC runner) broke on `creates a new item for an event earlier today` with
`expected undefined to be 'calendar'`. Reproduced locally with `TZ=UTC` at 21:47Z. It passed for the
author (UTC+3) because runner-local midnight coincided with the config TZ.

**The masking trap:** `applyPastEventToExisting` terminates in the *same* `updateExistingCalendarItem`
call as the non-past branch. So any fixture with an **existing** item passes identically whether or not
it is classified as past — the test keeps going green while silently exercising the wrong branch and
losing its coverage. Only **create**-path tests (no existing item) fail loudly, because a new past
event is dropped. Do not conclude "the sibling test passes, therefore it is fine."

**How to apply:** on any calendar test touching the today-cutoff —
- Never anchor a fixture to `dayjs().startOf('day')`. Either express intent relative to `dayjs()`
  (`subtract(1,'hour')` / `add(1,'hour')`), or pin the clock with `vi.setSystemTime` (see
  `honors calendar timeZone for the today cutoff`, the model to copy).
- Verify TZ-robustness by brute-forcing runner-TZ × 24 UTC hours against the config cutoff, not by
  running the suite once and seeing green.
- Reproduce with `TZ=UTC npx vitest run ...` — plain `npm test` on a UTC+3 machine will not show it.

**Fake timers wrap real Mongo I/O in this file — the `try/finally` is load-bearing, not hygiene.**
`calendar.test.ts` has NO `afterEach`, and vitest config sets no `restoreMocks`/`clearMocks`; the
`beforeEach`'s `vi.restoreAllMocks()` does NOT restore timers. So a `vi.useFakeTimers()` left installed
by an assertion failure would freeze the clock for every later test in the file. Always require the
`finally { vi.useRealTimers(); }`.
Frozen `setTimeout` is safe here only because the awaited code hits sockets (libuv I/O), not timers —
but `pushPaced`'s `await sleep(BACKFILL_PACE_MS)` (routes/calendar.ts, outbound routine backfill) WOULD
hang forever under fake timers. It is unreachable in these tests only because they seed zero routines
(`hasAtLeastOne(routines)` short-circuits). If you ever pin the clock on a test that seeds 2+ routines
and touches the outbound backfill, it will hang — advance timers or don't fake them.

**Still-open sibling (verified 2026-07-13, NOT a regression):** `pushes a single-instance override when
a routine-generated item is edited` fails at extreme east offsets (`TZ=Pacific/Kiritimati`, UTC+14) with
`expected '2026-05-05' to be '2026-05-04'` — same local-midnight family, fails identically on the
pre-change file. Out of scope for the fix above; don't re-diagnose it as caused by a cutoff change.
