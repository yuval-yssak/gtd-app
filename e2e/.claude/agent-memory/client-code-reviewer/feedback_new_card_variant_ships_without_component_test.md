---
name: new-card-variant-ships-without-component-test
description: New weeklyReview card/banner components land with pure-state unit tests only — the component's own branches (missing entity, fallback text, disabled states) go untested
metadata:
  type: feedback
---

New presentational components in `components/weeklyReview/` reliably ship with thorough tests for
the *pure state helper* they depend on and **zero** tests for the component itself. The e2e covers
one happy path; every fallback branch the reviewer flagged as a risk is the one with no coverage.

**Why:** the pure module (`reviewFlowState.ts`) is trivially testable, so it absorbs all the test
effort. The component's branches are the ones guarded by `?? null`, `routine ? … : 'no longer
exists'`, `disabled={!routine}` — exactly the paths a reviewer worries about and no test exercises.

**How to apply:** when a diff adds a `*Card.tsx` / `*Banner.tsx` under weeklyReview, enumerate its
conditional renders and check each has either a component test or an e2e assertion. Typical
uncovered set: entity-missing fallback copy, undefined-schedule fallback, paused chip, occurrence
count pluralization (`1 occurrence`), and the confirm-dialog's confirm branch (the e2e usually only
clicks Cancel).

Related: [[feedback_conditional_render_gate_loses_coverage]],
[[feedback_dismiss_button_tests_pass_by_timeout]].
