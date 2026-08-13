---
name: fire-and-forget-cascade-assertions-need-waitfor
description: "When a side effect moves from synchronous to op-driven/fire-and-forget, existing tests keep passing on microtask luck — grep for bare assertions on cascade results and demand vi.waitFor"
metadata:
  type: feedback
---

Refactors that convert a synchronous side effect into an op-driven `void notifyChange(...)` /
`maybePushToGCal(...)` fire-and-forget leg leave the *old* tests green, because in a fast local
Mongo the cascade usually wins the microtask race before the next `await` in the test body.
They are then silently timing-dependent and will flake on CI / loaded machines.

**Why:** proven on the reassign overhaul — `reassign.test.ts` asserted `sourceItem?.status === 'trash'`
with no polling right after the response. Injecting a 300ms delay in front of
`trashGeneratedCalendarItems` flipped it to a hard failure, while the sibling test in the same
describe block *did* poll. Same file, same cascade, inconsistent discipline.

**How to apply:** whenever a diff moves work behind a fire-and-forget boundary, grep the touched
test files for assertions on that work's observable result and require `vi.waitFor` (or the
existing poll helper) on every one — not just the ones that happened to fail. To confirm a bare
assertion is genuinely timing-dependent rather than incidentally ordered, inject a `setTimeout`
delay at the head of the async cascade and re-run; a pass under that probe means the ordering is
real, a failure means the test was riding luck.

Related: [[feedback_verify_tests_discriminate_by_stashing_source]],
[[project_sync_purge_test_timing_traps]].
