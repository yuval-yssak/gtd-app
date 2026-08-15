---
name: conditional-render-gate-loses-coverage
description: Narrowing an always-rendered element behind a new boolean gate (e.g. `issue.retryable && detail`) ships with only the now-hidden branch tested; the still-shown branch loses all coverage.
metadata:
  type: feedback
---

When a change turns `{x && <El/>}` into `{gate && x && <El/>}`, the accompanying test almost
always asserts only the *new negative* — `toHaveCount(0)` on the branch that is now hidden. The
positive branch (gate true → element still renders) silently ends up with zero coverage, so a
later typo in the gate expression, or a server field rename that makes `gate` always falsy, would
delete the element for every user without failing a single test.

**Why:** absence assertions are cheap to write and feel like they prove the change worked. They
prove half of it. The half that regresses in production is the one where the element must still
appear. This has now shown up in the SyncIssuesPanel `failureDetail` gating (only the terminal
`entity_missing` path was staged e2e; the retryable path with a real provider error string had
no test at all).

**How to apply:** On any diff that adds a condition in front of previously-unconditional JSX:
1. Find the assertion for the hidden branch — it will be there.
2. Ask for the mirrored positive assertion. If staging the real backend state for it is expensive
   (as with retryable GCal failures), push for the presentation logic to be extracted into a pure
   helper in `src/lib/` or a `*Logic.ts` sibling and unit-tested both ways — that is the
   established pattern here (`calendarRowMetaLogic`, `AccountReauthDialog.staleAccountRows`).
3. Treat "the e2e covers it" as insufficient when the e2e only stages one branch.

Related: [[feedback_dismiss_button_tests_pass_by_timeout]] — same family of defect, a test that
greens for a reason other than the behaviour it names.
