---
name: Public-API projections inconsistent on whether to expose `user`
description: `presentItem` exposes the `user` field; `presentRoutine`, `presentPerson`, `presentWorkContext` do NOT. `v1References.test.ts` asserts work-contexts hide `user`; `v1Routines.test.ts` GET /:id asserts routines hide it too. Watch for new projections drifting either way.
type: project
---

As of Phase 2 step 3, three of the four `/v1/*` projections (`presentRoutine`, `presentPerson`, `presentWorkContext`) deliberately exclude `user`. Only `presentItem` (`routes/v1/projections/item.ts`) still includes it in `PUBLIC_FIELDS` — that's tracked as a Phase 3 cleanup because `v1Items.test.ts` and external clients depend on the current shape.

**Why:** the `/v1/*` API is per-token, and the token already implies the user. Exposing `user` in responses is redundant and (mildly) leaks the Better Auth user ID to integrations that don't need it. The inconsistency is a contract drift; the user has chosen to roll the items projection cleanup into Phase 3 rather than break clients now.

**How to apply:** when reviewing a new `/v1/*` projection, drop `user` from `PUBLIC_FIELDS` to match the new majority. Pin the no-leak invariant in tests (`expect(body.user).toBeUndefined()` or `expect(body[0]).not.toHaveProperty('user')`). When the items-projection cleanup lands in Phase 3, also add a regression test asserting the new shape so a future revert doesn't silently reintroduce the leak.
