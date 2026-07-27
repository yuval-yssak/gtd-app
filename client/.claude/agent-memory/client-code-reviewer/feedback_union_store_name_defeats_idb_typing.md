---
name: union-store-name-defeats-idb-typing
description: Replacing per-entity IDB helpers with one entityType→storeName map makes tx.store a union, widening put() to accept any entity type into any store — a silent typing regression.
metadata:
  type: feedback
---

Refactors that collapse per-entity IDB helpers (`putItem`/`putPerson`/…) into a single
`ENTITY_TYPE → STORE_NAME` map look DRYer but **silently destroy store/value type pairing**.
`db.transaction(MAP[entityType])` with a union key makes `tx.store` a union of object stores,
and TypeScript widens `put`'s parameter to the *union* of all value types.

**Why:** Verified on the 2026-07-27 sync-apply rewrite — `Parameters<typeof tx.store.put>[0]`
resolved to `StoredItem | StoredRoutine | StoredPerson | StoredWorkContext`, so writing a
person snapshot into the `items` store type-checks cleanly. The `entityType` driving the lookup
comes off the wire from the server, so there is no compile-time *or* runtime objection to a
mismatched op corrupting a store. The old per-entity helpers were more verbose but pinned the
pairing in one concretely-typed place each.

**How to apply:** Whenever a diff introduces `as const satisfies Record<EntityType, keyof MyDB>`
(or similar) and indexes a transaction by it, prove the weakness before flagging — add a
temporary `const probe: never = null as unknown as Parameters<typeof tx.store.put>[0];` and run
`npm run typecheck`; the error message names the widened union. Then require a generic that
re-ties store name to value type (`<K extends StoreName>(storeName: K, ...)`), which usually
also removes the `as unknown as StoredEntity` double assertion that accompanies it.

Also check whether the new map duplicates an existing one elsewhere — this codebase already had
`ENTITY_STORE_BY_TYPE` in `syncRecoveryActions.ts` when the second copy landed.
