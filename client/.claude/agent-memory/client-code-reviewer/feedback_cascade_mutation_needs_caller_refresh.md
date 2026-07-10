---
name: cascade-mutation-needs-caller-refresh
description: When a db-layer mutation gains a NEW cascade (trashes/creates a second entity type), every route caller must add the matching refreshX() before syncAndRefresh, or the local IDB change is invisible until a network round-trip.
metadata:
  type: feedback
---

When a db-layer mutation that previously touched only entity A is changed to also cascade into entity B (e.g. `removeRoutine` now also trashes the routine's open items), each route caller must add the matching `await refreshB()` alongside its existing `await refreshA()`, positioned BEFORE `syncAndRefresh()`.

**Why:** `syncAndRefresh()` does eventually `triggerAppResourceRefresh('all')`, so the UI self-heals after the network round-trip — but that hides an offline/latency gap: the locally-trashed rows stay visible until flush+pull completes (and if offline, until the next successful sync). The sibling handler for the same entity models the correct pattern — e.g. `onConfirmPause` in `routines.tsx` calls `refreshRoutines()` then `refreshItems()` then `syncAndRefresh()`, precisely because `pauseRoutine` cascades to items. A delete handler that only refreshes the primary entity is the tell.

**How to apply:** Whenever a reviewed diff adds a cross-entity cascade to a mutation, grep every caller of that mutation and confirm each refreshes the newly-affected entity locally. The diff often won't include the caller file — flag it anyway. Cross-check against the "IDB mutation pattern" rule (write IDB → queue op → refresh) applied per affected entity type, not just the mutation's original one.
