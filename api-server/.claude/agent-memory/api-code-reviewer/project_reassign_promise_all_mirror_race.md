---
name: Reassign auto-relink Promise.all races mirror-create
description: relinkPeopleIds / relinkWorkContextIds use Promise.all over find-or-create; two ids resolving to the same target match (shared email, shared name, or duplicate id) both fail the "exists" check and each insert a fresh mirror — silent duplication under toUserId.
metadata:
  type: project
---

`relinkPeopleIds` and `relinkWorkContextIds` in `lib/reassignEntity.ts` parallelize `Promise.all(ids.map((id) => relinkPersonId(id, ctx)))`. Each per-id call does: `findByOwnerAndId` (source) → `findPersonByEmailOrName` (target) → `applyAndPublishOperation('create')` if no target match.

**Why this races:** the find and the create are not atomic, and no unique index on `(user, email)` or `(user, name)` exists on the people/workContexts collections. Two concurrent calls that resolve to the same match key both observe "no target row" and both insert a fresh mirror. Resulting state on toUserId: N+1 rows where 1 was intended; the moved item's `peopleIds[]` carries the duplicated set of new ids.

**Three concrete trigger shapes:**
1. `peopleIds: [a1, a1]` — same source id twice.
2. `peopleIds: [a1, a2]` where source persons `a1` and `a2` share an `email`.
3. `peopleIds: [a1, a2]` where neither has an email and they share a `name`.

**How to apply:** When reviewing reassign or any future find-or-create batch helper:
1. Prefer sequential iteration over `Promise.all` for paths that mutate the same target keyspace.
2. Add a per-match-key memoization map so duplicate source ids/keys collapse to a single create.
3. Demand regression tests for the three trigger shapes above before approving.
4. If a unique index is appropriate (product allows no duplicate email per user), back that with E11000-catch-and-retry on the insert — but that's a product call.
