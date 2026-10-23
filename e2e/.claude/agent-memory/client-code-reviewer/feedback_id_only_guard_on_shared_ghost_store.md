---
name: feedback-id-only-guard-on-shared-ghost-store
description: Using the cross-page listGhosts store as an id-only "already acted" guard silently blocks unrelated actions; ghosts are recorded on every status change and can be left unconsumed
metadata:
  type: feedback
---

When a fix reuses the module-level ghost store (`lib/listGhosts.ts`) as an "already done" guard keyed only by item id (`hasGhost(id)`), it also matches ghosts from OTHER lists: `recordGhostIfLeavingList` records on every status change (inbox/calendar/someday → nextAction too), and a ghost is only consumed when a mounted list row finishes its collapse. Surfaces without `useListGhosts` (calendar, weekly review, `/item/$id`), virtualized-out rows, and an undo within the 700 ms linger all strand the entry. `hasGhost` also ignores the TTL; pruning only runs on record and on list mount. Result: a dead Done button for a fresh next action, which no test covers.

**Why:** Round 4 of exp/next-actions-keyboard (2026-10-23). The Done double-press fix passed its own e2e but blocked any item that changed status elsewhere within 60 s, and kept blocking it until something pruned the store.

**How to apply:** When a guard reads a shared store, check what writes to that store besides the action being guarded. Ask for the guard to match the exact snapshot (status + updatedTs, or the object identity), and for an e2e that changes the status on another surface, navigates in-app (not `page.goto`, which wipes module state), then acts. Related: [[project-refresh-resolves-before-transition-commit]].

Resolution accepted in round 5: `isGhostOf(item)` (status + updatedTs + TTL) plus the in-flight set. Residual window judged acceptable: a refresh that read IDB before the Done write and lands after the in-flight set clears can render a pull-updated (different `updatedTs`) live snapshot that the snapshot match no longer blocks. Needs a remote edit of the same row in the same ms window — don't re-raise it as a critical.
