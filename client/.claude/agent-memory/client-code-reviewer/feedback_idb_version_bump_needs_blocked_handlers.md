---
name: idb-version-bump-needs-blocked-handlers
description: Every IDB schema version bump must be reviewed for blocked/blocking coverage AND for the v4→v5-style wipe list; the store-list and upgrade-callback halves drift independently and neither has a test that fails when forgotten.
metadata:
  type: feedback
---

When `openAppDB`'s version number in `client/src/db/indexedDB.ts` changes, three things must move together, and historically they have not:

1. **`blocked` / `blocking` callbacks must exist.** A v7→v8 bump shipped to staging with neither. `openDB` has no timeout, so any older connection (stale tab, PWA window, or a long-lived Service Worker connection) deadlocked the open forever. Because `main.tsx` awaits `openAppDB()` before mounting React, every new tab rendered a **blank page with zero console errors** — an extremely expensive failure mode to diagnose.
2. **Long-lived non-window contexts must not hold connections.** The Service Worker outlives its events; opening a DB per event without closing it makes the SW a permanent blocker of all future upgrades in every tab.
3. **The wipe/backfill store lists inside `upgrade()` are version-pinned.** `wipeCachedEntitiesAndSyncState` deliberately omits stores created by *later* versions (clearing them throws `NotFoundError` on the older upgrade path). A reviewer who "helpfully" suggests adding the newest store to that list is introducing a bug — read the comment before flagging.

**Why:** the staging blank-page incident. It cost real debugging time precisely because the symptom (blank page, no error) points nowhere near IndexedDB, and no existing test covers cross-connection behaviour — the migration suite only ever opens one connection at a time.

**How to apply:** treat any diff touching the version literal in `openAppDB` as high-risk regardless of how small it looks. Check all three points above. Also verify the tests are genuinely load-bearing by mutation-testing them (delete the handler, confirm the test fails) — a `blocking` test that only proves "the open completes" passes trivially in single-connection environments and fails only via test-timeout, which is slow and reads as flake. Ask for an explicit `blocking`-fired assertion rather than relying on timeout-as-assertion.

Related: [[concurrency-fix-untested-layer]] (same "mutation-test the layer before approving" discipline), [[no-dom-unit-test-infra]] (why pre-React DOM output can't get a vitest render test).
