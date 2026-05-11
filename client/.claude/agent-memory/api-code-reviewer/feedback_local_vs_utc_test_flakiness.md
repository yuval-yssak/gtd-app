---
name: Local-vs-UTC test flakiness pattern
description: Test code that computes "today" with dayjs.utc() while production code uses dayjs() local can flake near midnight on non-UTC dev machines, even if CI is UTC
type: feedback
---

Tests for routine/item bootstrap and date-anchored logic often use `dayjs.utc().format('YYYY-MM-DD')` to compute the expected "today" date. But production code (e.g. `routineItemGeneration.ts:computeFirstAnchor`) uses `dayjs().format('YYYY-MM-DD')` (local) so the anchor reflects the user's local calendar date.

This mismatch is invisible in UTC CI but produces flakiness for any developer running tests on a non-UTC machine within an hour or so of midnight in either direction.

**Why:** dayjs.utc() and dayjs() local return different YYYY-MM-DD strings whenever local midnight straddles a UTC day boundary (any TZ that isn't UTC for several hours per day). The fix is either (a) mirror the production helper: `dayjs().format('YYYY-MM-DD')` — not `.utc()`, or (b) pin the system clock with `vi.useFakeTimers({ toFake: ['Date'] }).setSystemTime(...)` like `client/src/tests/routineStartDate.test.ts` does.

**How to apply:** When reviewing new tests that compute "today"/"tomorrow" for assertions, check whether the production code path uses local or UTC, and require the test to use the same. Flag any test that has `dayjs.utc()` in the expected-value computation but reads from a code path that uses `dayjs()` without `.utc()`.
