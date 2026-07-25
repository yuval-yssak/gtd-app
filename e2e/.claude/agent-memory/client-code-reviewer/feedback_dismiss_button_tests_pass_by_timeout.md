---
name: dismiss-button-tests-pass-by-timeout
description: E2E tests asserting a snackbar/toast dismiss button work must defeat the component's own autoHideDuration, or they pass vacuously when the button does nothing.
metadata:
  type: feedback
---

Any e2e test that asserts "clicking the dismiss/close affordance hides the transient UI" is at risk of passing for the wrong reason, because the same UI also self-hides on `autoHideDuration`. `expect(...).toHaveCount(0)` has a default 5s Playwright timeout; the UndoSnackbar's `UNDO_SNACKBAR_DURATION_MS` is 6000ms, so today the assertion is genuinely load-bearing — but the margin is one constant edit wide. Drop the duration below the expect timeout (or raise the expect timeout) and the test greens out even if the close handler is deleted.

**Why:** transient UI has two independent paths to the same observable end state (hidden). Asserting only the end state cannot distinguish "the button worked" from "the timer fired". The GTD codebase exports these durations (`UNDO_SNACKBAR_DURATION_MS`), which makes them easy to tune later without anyone re-checking the tests that implicitly depend on them.

**How to apply:** When reviewing an e2e test for a close/dismiss button on a Snackbar, Alert, toast, or any auto-hiding surface:
1. Find the auto-hide duration constant and compare it to the assertion's effective timeout.
2. Recommend the test prove causality, not just the end state — assert the snackbar is *still visible* immediately before the click, then assert it disappears fast (an explicit short `{ timeout }` well under the auto-hide duration).
3. Note that the corresponding "it did NOT auto-hide" control is what makes the test meaningful.

Related: [[project_multi_chrome_editor_pattern]] — undo snackbar is shared by all the editor chromes, so one weak test covers many surfaces.
