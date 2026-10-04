---
name: tab-sticky-account-vs-idb-pointer
description: AppDataProvider's `account` is frozen at boot; db-layer "was this the active account?" checks read the IDB pointer, which another tab may already have moved — the tab keeps rendering a removed account.
metadata:
  type: project
---

`initial.account` in AppDataProvider is sticky for the tab's lifetime (account switch = reload). Any db-layer
logic that decides "navigate vs refresh in place" by reading IDB `activeAccount` (e.g. evaporateUser's
`wasActive`) gives the wrong answer in a second tab once the first tab has re-pointed IDB to a survivor:
the second tab refreshes in place and keeps operating on the removed account.

**Why:** found in account-deletion round 2 (2026-10-04); the fix for "no active pointer left" covered only
the pointer-absent case, not the pointer-moved case.

**How to apply:** when a change removes/switches an account from a non-UI path, check that the window-event
listener compares the event's userId with the tab's in-memory `account.id` and reloads on a match.
Related: [[cookie-idb-active-account-drift]]. Also check `return` inside `try` with a session-restoring
`finally` — the restore still runs after a "navigated" early return.
