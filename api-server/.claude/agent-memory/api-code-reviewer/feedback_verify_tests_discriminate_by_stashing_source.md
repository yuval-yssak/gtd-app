---
name: verify-tests-discriminate-by-stashing-source
description: Run new regression tests against the UNMODIFIED source (stash the src file, not the test file) to prove each one actually fails without the fix.
metadata:
  type: feedback
---

When a diff ships tests described as regression coverage, verify each one discriminates: stash ONLY the
source file, re-run the named tests, confirm they fail, then pop.

```
git stash push src/routes/<file>.ts
npx vitest run src/tests/<file>.test.ts -t "<test name>"
git stash pop
```

**Why:** on the exception-inherit-master-gcal-owned review, 1 of 3 new tests failed on the unmodified tree
(real regression test) while the other 2 passed (forward-guards that prove nothing about the fix). That
distinction is invisible from reading the test — both looked like proper regression tests. This repo has a
recurring pattern of non-discriminating tests (see [[regen-done-unmask-test-nondiscriminating]],
[[withtimeout-string-simulated-tests]], [[gcal-pushback-suppression-test-needs-integration-seed]]).

**How to apply:**
- Stash the SOURCE file, never the test file. `git checkout <testfile>` and `git stash push <testfile>`
  will destroy uncommitted test work that has no other copy — on this review I wiped 155 lines of the
  user's uncommitted tests that way and had to reconstruct them from the diff in context.
- To probe runtime behavior, prefer asserting a deliberately-wrong value (`expect(x).toEqual('PROBE')`)
  and reading the diff output — vitest suppresses `console.log` even with `--silent=false`.
- Non-discriminating tests are not a blocker on their own; report them so they aren't miscounted as
  regression coverage, and demand a discriminating test for any behavior change that lacks one.
