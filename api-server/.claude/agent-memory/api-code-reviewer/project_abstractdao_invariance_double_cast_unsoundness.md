---
name: abstractdao-invariance-double-cast-unsoundness
description: `AbstractDAO<T>` is invariant in T (T appears in both `replaceById(doc: T)` input and `findByOwnerAndId(): Promise<T|null>` output positions). `as unknown as AbstractDAO<SuperType>` double-casts compile but are unsound for any write method.
metadata:
  type: project
---

`AbstractDAO<ItemInterface>` IS NOT assignable to `AbstractDAO<EntitySnapshot>` even though `ItemInterface` is part of the `EntitySnapshot` union. The class uses `T` in contravariant positions (`replaceById(doc: T)`, `insertOne(doc: T)`), so widening `T` would let callers pass e.g. `RoutineInterface` to an items-backed DAO.

The `as unknown as AbstractDAO<EntitySnapshot>` double-cast pattern (seen in `applyEntityOp.ts:pickDAOForHydration`) is only safe as long as the consumer touches **only output-position** methods (`findByOwnerAndId`, `findArray`, etc.). The moment someone adds a `replaceById` or `deleteByOwner` call on the cast variable, type-level unsoundness becomes runtime corruption — and TypeScript will not warn.

**Why:** Saw this on the snapshot-null delete fan-out PR. The `pickDAOForHydration` switch returned `AbstractDAO<EntitySnapshot>` via double cast purely for hydration's `findByOwnerAndId` call. Compiles, runs, but the type contract is wider than the actual safety guarantee.

**How to apply:** When reviewing helpers that dispatch on `entityType` and return a DAO, prefer a structural type narrowing to the minimum capability used:
```ts
type HydrationDAO = { findByOwnerAndId(id: string, userId: string): Promise<EntitySnapshot | null> };
```
This makes the cast width-narrowing (sound under covariance) instead of soundness-overriding. Flag any `as unknown as AbstractDAO<...>` cast in review.
