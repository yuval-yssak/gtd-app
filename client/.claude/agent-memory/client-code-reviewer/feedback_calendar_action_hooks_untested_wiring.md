---
name: calendar-action-hooks-untested-wiring
description: CalendarIntegrations action hooks (useSyncNow/useRepairSync) get pieces unit-tested but the API→syncAndRefresh→setSummary composition inside the hook is untested.
metadata:
  type: feedback
---

New action hooks in `CalendarIntegrations.tsx` are cloned from `useSyncNow` and reliably ship with the API wrapper + any formatter (e.g. `summarizeRepair`) unit-tested in isolation, but the load-bearing hook composition — call API inside `withActiveAccountSession` → then `syncAndRefresh()` (to pull server-authored ops into IDB) → then set summary/error under an `isMountedRef` guard — has no test.

**Why:** the individual pieces passing doesn't prove the wiring; `syncAndRefresh` is what makes repaired/synced entities actually appear, and it's easy to drop or mis-order. This is the [[passthrough_helper_untests_wiring]] shape applied to these hooks. Note `useSyncNow` itself has no wiring test, so the gap is pre-existing convention, not a regression — flag as a gap, don't block on it alone.

**How to apply:** when reviewing a new `use<Action>` hook in this file, ask for a hook/component test that mocks the calendar API call and asserts `syncAndRefresh` was invoked AND the summary/error state renders from the returned value. Related: [[uncancellable_settimeout_in_routes]] (unmount safety already handled here via isMountedRef).
