---
name: project-switch-choice-vs-midpass-pivot
description: Account-switch-vs-sync-pass fixes tend to guard only the pass's finally-restore, not the per-user setActiveAccount pivots that still run after the user's choice
metadata:
  type: project
---

Fixes for "switch reverts to old account" (fix/account-switch-race, 2026-11-07) made the pass's
finally-restore yield to a recorded user choice, but syncOneUser / withAccountSession keep pivoting
IDB activeAccount to the NEXT survivor after the choice. Since the switch hard-reloads, the old page
often dies before the restore runs, so a later pivot is an equally likely clobber.

**Why:** tests (unit + e2e) only exercised the harmless direction (switch target == account synced
next), and the e2e cancels the reload with a 204 so the restore always gets to run.

**How to apply:** for any active-account race fix, ask: active=B, switch to A while A's (first)
pull is held — does the pass still write B before the page unloads? Demand the loop stop pivoting
once a choice is recorded. Related: [[project-cookie-idb-active-account-drift]], [[project-tab-sticky-account-vs-idb-pointer]].

Follow-up (same day): fix moved to a terminal per-page pick (isPivotAllowed) + intended-account reads. Once readSettledActiveAccount / gtd.getActiveAccountId resolve the *intended* account, any e2e/unit "active account is X" check made in the picking page is tautological; only a raw IDB read or a fresh boot proves the stored pointer.
