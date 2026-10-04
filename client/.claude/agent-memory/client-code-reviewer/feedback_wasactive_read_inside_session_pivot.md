---
name: wasactive-read-inside-session-pivot
description: Any "was this the active account?" decision taken inside a multiUserSync pass reads the PIVOTED IDB pointer, not the user's real active account — spurious reloads / wrong-survivor switches
metadata:
  type: feedback
---

syncOneUser pivots IDB `activeAccount` to the user being synced before flush/pull. Any side effect run from inside that window (401 catch, missing-session branch) that reads `getActiveAccount` — e.g. evaporateUser's `wasActive` — sees the pivot target, not the user's choice. Found 2026-10-04 (account-deletion round 3): a background account's 401→tombstone made evaporation think it was active → reload + IDB pointed at `remaining[0]` instead of the user's account, and the `reloadScheduled` guard then skipped the restore. The existing test passed because with 2 accounts `remaining[0]` happened to be the real active one and it never asserted `location.href`.

**Why:** tests inject `onUserDeleted` mocks, so the default evaporation's active-detection is rarely exercised under a real pivot.

**How to apply:** for any new decision inside the pass that depends on "active", demand either deferral until after `restorePreviouslyActiveSession`, or passing the pre-pass active id explicitly; require a 3-account test (active ≠ first survivor) asserting no navigation. Related: [[local-first-gesture-leaves-server-state-behind]].
