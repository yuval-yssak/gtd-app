---
name: timezone-fixture-tests-wallclock-vacuous
description: Timezone-aware date tests that assert against a live-clock helper (localDateInTimezone with no `at`) are vacuous for most hours of the day — the fixture zone silently agrees with UTC
metadata:
  type: project
---

A test that seeds a device timezone and then asserts
`expect(item.expectedBy).toBe(localDateInTimezone('Pacific/Kiritimati'))` only discriminates
during the hours when that zone's calendar date actually differs from the server's UTC date.

Measured on the tickler day-boundary work (GTD 8260d68a): stashing `resolveUserTimezone` to
always return `'UTC'` (the pre-fix behaviour) failed **only 1 of the 4** new timezone tests in
`src/tests/routineItemGeneration.test.ts`. A 24-hour sweep showed:
- `Pacific/Kiritimati` (UTC+14) differs from UTC for **13 of 24** hours
- `Pacific/Pago_Pago` (UTC-11) differs for **10 of 24** hours
- both differ simultaneously for only **1** hour
- neither differs: **0** hours

So the *suite as a whole* always catches a total regression (there is no hour where all fixtures
agree with UTC), but each individual test is a coin flip, and a partial regression that only
breaks the positive-offset path can pass a whole CI run.

**Why:** the assertion's expected value is computed from the same live clock the code under test
reads, so when the fixture zone and UTC happen to share a calendar date the assertion reduces to
`utcToday === utcToday`.

**How to apply:** when reviewing any timezone/day-boundary work, do not accept
"the fixture zone is UTC+14 so it must differ." Require the clock be pinned with
`vi.setSystemTime`, and **compute the pin instant rather than guessing it** — I recommended
`22:00Z` and was wrong: at 22:00Z Pago Pago (UTC-11) reads 11:00 the *same* day and agrees with
UTC, so that pin would have left half the tests vacuous. For a UTC+14 / UTC-11 fixture pair the
only both-disagree window is **10:00–11:00Z** (the fix pinned 10:30Z). Derive the window with a
short `Intl.DateTimeFormat(…, {timeZone})` sweep before endorsing an instant.

Also require literal-date assertions (`toBe('2026-08-31')`) rather than re-deriving the expected
value from the helper under test — a pinned clock plus a derived expectation is still circular.

Verify by stashing the source per [[feedback_verify_tests_discriminate_by_stashing_source]] and
confirming EVERY new test fails, not just one. Worth stashing two distinct bug shapes (resolver
forced to `'UTC'`, and the recency sort reversed) — they exercise different assertions.

Fake timers here need `vi.useFakeTimers({ shouldAdvanceTime: true })` plus an
`afterEach(vi.useRealTimers)`; without `shouldAdvanceTime` the Mongo driver's internal timers
stall and DB calls hang. Tests under the pin should call the generator functions directly with
seeded fixtures rather than logging in through the HTTP surface.

Same failure shape as [[project_calendar_test_local_startofday_tz_fragility]], but inverted:
there the runner's local zone was the hazard, here the *fixture* zone is.
