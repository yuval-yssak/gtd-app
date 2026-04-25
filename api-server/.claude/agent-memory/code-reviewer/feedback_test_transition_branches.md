---
name: Transition-detection features need same-timestamp/no-prior-op test cases
description: Pattern-level feedback — new pushback transition branches (pause/resume, active-flag changes, etc.) repeatedly ship with tests for the happy transition but not the edge conditions that break the detector
type: feedback
---

When the codebase adds a new "detect a transition" branch to pushback — e.g. pause vs resume driven by `active`-flag diffing, or first-time-create vs update, or delete-vs-edit — the tests tend to cover the central happy paths and skip the edges that would actually break the detector. Require coverage of:

- **Same-timestamp collision:** seed a prior op AND a current op with the same `updatedTs` (and confirm transition is still detected after the `_id`-based filter fix).
- **No prior op at all:** the very first push for the entity. The detector should return null/untouched and fall through to steady-state.
- **Double-transition (idempotency):** push the same transition twice back-to-back. Second push should be a no-op.
- **Happy path for BOTH sides of the transition:** if a PR adds pause tests, it must also add resume tests. Asymmetric coverage is a smell.

**Why:** The active-flag detector in calendarPushback.ts shipped correct for the happy path but incorrectly handles the same-`updatedTs` collision because the test only seeded the prior op, never the current one. One test insertion would have caught the bug. This is a repeating shape: transition code is easy to write for the 80% case and accidentally miss the 20%.

**How to apply:** Whenever a PR adds a new transition branch to a pushback helper, search the accompanying tests for each of the four items above. Flag any that's missing — "add a test that seeds both prior and current ops with identical updatedTs to verify the _id-based filter works" is the canonical form.
