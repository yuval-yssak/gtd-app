---
name: fake-provider-must-expose-every-reachable-method
description: A hand-rolled fake CalendarProvider that omits a method the code path can reach makes "not.toHaveBeenCalled()" assertions vacuous — the guard mutant survives
metadata:
  type: feedback
---

Hand-rolled `fakeProvider()` objects in calendar tests typically define only the 2–3 provider
methods the happy path uses (`updateRecurringInstance`, `updateEvent`, `getCalendarTimeZone`).
A "this input must be SKIPPED" test then asserts `expect(provider.updateRecurringInstance)
.not.toHaveBeenCalled()`. If removing the guard routes that input to a **different** provider
method the fake never defined, the assertion still passes — and the test proves nothing.

**Why:** found on the missed-push sweep's status filter. The skip test used `status: 'trash'`, but
`handleItemPush` routes trash to `pushRoutineInstanceCancellation` → `cancelRecurringInstance`,
absent from the fake. Mutating `if (item.status !== 'calendar' && item.status !== 'done')` to
`if (false)` left 22/22 green even though the log showed `[gcal-pushback] cancelling routine
instance` — the sweep really did reach Google. Adding `cancelRecurringInstance: vi.fn()` to the
fake made the same test fail correctly, proving the fake was the blind spot, not the assertion.

**How to apply:** when a skip/guard test asserts `not.toHaveBeenCalled()` on a provider mock, first
trace where the input lands *with the guard removed* and confirm that method exists on the fake.
Prefer asserting on the whole fake (e.g. every `vi.fn()` in the object has zero calls) over naming
one method, so a re-route into an unmocked method surfaces as a TypeError instead of a false pass.
Same class as [[feedback_run_fence_mutation_before_trusting_it]] — always run the mutant.
