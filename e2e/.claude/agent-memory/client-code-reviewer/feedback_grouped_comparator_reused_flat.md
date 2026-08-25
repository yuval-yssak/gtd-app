---
name: grouped-comparator-reused-flat
description: A key-comparator written for unique bucket keys becomes an invalid (asymmetric) comparator when reused on a flat item list; sentinel-vs-sentinel is the bug.
metadata:
  type: feedback
---

When a "flatten the page order into one comparator" change reuses a helper that previously only sorted **unique** grouping keys, check the equal-key case first — the old caller made it unreachable, the new one makes it common.

**Why:** `compareDayKeys` in `calendarRouteSort.ts` read `if (a === NO_DATE_KEY) return 1; if (b === NO_DATE_KEY) return -1;`. Fed `Object.keys(buckets).sort(...)` the two keys are never equal, so it was correct. `compareCalendarItems` applied it to a flat item list, where two undated items both map to the sentinel and `cmp(a,b) === cmp(b,a) === 1` — antisymmetry violated, `compareWithinDay` never reached, and the flat walk provably diverged from `groupCalendarItemsByDay` (the exact mismatch the change existed to eliminate). Fix is `if (a === b) return 0;` ahead of the sentinel branches.

Second-order trap in the same fix: once the day-level ties, undated pairs fall through to the within-day rule, where `dayjs(undefined).valueOf()` is `Date.now()` read twice — nonzero jitter, not 0. Any "missing field" comparator branch that leans on a date lib's parse-undefined behavior needs an explicit tie guard.

**How to apply:** when a diff exports a new flat comparator composed from existing grouping helpers, (1) write the equivalence test against the real grouping function rather than a hand-built example — a randomized/multi-tie input catches what one curated case misses; (2) demand a tie test asserting `cmp(a,b) === 0` AND `cmp(b,a) === 0` for every sentinel/missing-field pair; (3) check whether any comparand is `undefined` when passed to `dayjs()`.

Related: [[feedback_shared_comparator_ties_destabilize_e2e_order]], [[feedback_lifted_helper_leaves_original_test_home]].
