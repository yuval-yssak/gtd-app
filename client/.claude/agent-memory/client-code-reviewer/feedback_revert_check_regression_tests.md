---
name: revert-check-regression-tests
description: On a re-review after "changes applied", don't just run the new tests green — temporarily revert each fix and confirm its regression test actually fails. Cheap, and it catches tests that pass either way.
metadata:
  type: feedback
---

When re-reviewing a round-N+1 batch that claims "all requested changes applied", verify each fix by **reverting it in place and re-running the pinning test**. A test added alongside a fix frequently passes against the pre-fix code too — it exercises the happy path rather than the adversarial shape that was actually broken.

Procedure that worked well (whole loop is well under a minute for unit tests):
1. `cp <file> /tmp/x.bak`, patch the specific hunk back to the old implementation (a small `python3` heredoc replace is more reliable than `sed` for multi-line hunks).
2. Run the targeted suite; expect exactly the new test(s) to fail, and note *which* — a fix whose test still passes is a gap to report.
3. `cp /tmp/x.bak <file>`, then confirm restoration with `git diff --stat` matching the pre-experiment diffstat.

Worth doing for e2e too when the fix is a wiring change (e.g. neutralize the call site to a pass-through and confirm the spec goes red) — that is the only way to distinguish "the e2e covers the fix" from "the e2e passes for unrelated reasons".

**Why:** this repo's CLAUDE.md makes reviewer approval a hard gate, and a one-shot review has no follow-up round — so "the tests are green" is not evidence the reported bug can't regress. Also directly counters [[fixed-critical-ships-without-its-e2e]], where the new abstraction gets unit-pinned but the originally-reported bug keeps no regression test.

**How to apply:** run it for every issue previously flagged as Critical. Always restore from the backup and re-verify the diffstat before writing the verdict — never leave an experiment in the tree. Environment-sensitive fixes (timezone, locale, clock) need the extra step of running the test under several `TZ=` values, since a zone-dependent assertion is green on the author's machine by construction — see [[dayjs-issame-floating-vs-offset]].
