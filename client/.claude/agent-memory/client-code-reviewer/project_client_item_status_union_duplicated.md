---
name: client-item-status-union-duplicated
description: Client has no shared exported ItemStatus type; the status string-literal union is duplicated inline across files — don't flag a new local copy as a violation.
metadata:
  type: project
---

The client side (`src/types/MyDB.ts`) does NOT export an `ItemStatus` named type the way the server's `entities.ts` does. `StoredItem.status` inlines the literal union `'inbox' | 'nextAction' | 'calendar' | 'waitingFor' | 'somedayMaybe' | 'done' | 'trash'`, and that same union is duplicated inline in several files (`editItemDialogLogic.ts`, `itemSearch.ts`, `api/assistApi.ts`, `routes/_authenticated/item.$itemId.tsx`).

**Why:** `MyDB.ts` mirrors server entities but only re-exports `EnergyLevel`, not `ItemStatus`. No one has centralized the status union on the client.

**How to apply:** When reviewing a new client file that defines its own local `ItemStatus`/status union, do NOT flag it as a fresh DRY violation — it matches existing client convention. At most note it as a non-blocking suggestion (a future shared `ItemStatus` export in MyDB would dedupe all copies, including the proposal-schema mirror).
