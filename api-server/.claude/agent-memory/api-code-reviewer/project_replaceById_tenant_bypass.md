---
name: replaceById is not user-scoped — tenant isolation depends on _id unguessability
description: AbstractDAO.replaceById replaces by `_id` only (with upsert:true), no user filter. applyEntityOp's pre-check is by-owner but a missing-row goes through. Pre-existing in /sync/push; Phase 2 widened the surface to /v1/operations/batch.
type: project
---

`AbstractDAO.replaceById(entityId, doc)` runs `replaceOne({ _id: entityId }, doc, { upsert: true })` — no `user` clause. The shared apply pipeline guards against cross-tenant *update* via `findByOwnerAndId(entityId, userId)` first; if the row doesn't belong to the calling user, `existing` is null and `applyEntityOp` falls through to `replaceById` unconditionally.

Net effect: a token (or session) for user A can clobber any other user's row by submitting a `create` op whose `entityId` matches that row's `_id`. The snapshot's `user` is server-re-stamped to A, so the row is effectively *moved* from B to A. Tenant isolation today rests on `_id` unguessability.

**Why:** the codebase treats UUIDs as both keys and capability tokens. `/sync/push`'s misroute guard checks `snapshot.userId !== session.user.id` — but only when the client tags `userId`. An attacker sending a snapshot without `userId` slips past the guard and lands in `applyEntityOp`. Phase 2 step 6 exposes the same primitive to any token with the relevant `<entity>.write` scope via `/v1/operations/batch`.

**How to apply:** when reviewing any path that calls `applyAndPublishOperation(s)` for a `create` op with an externally-supplied `entityId`:
1. Treat foreign-id-collision as a real risk (not just a UUID-collision-rate concern).
2. The right fix is layered: (a) `replaceById` should require `user` in its filter and refuse the upsert when ownership disagrees, (b) `applyEntitySnapshotOp` should distinguish "row exists under another user" from "row doesn't exist".
3. Until that lands, flag any new public-surface path that lets a caller specify `entityId` for a `create` op — `/v1/operations/batch` is one such surface.
4. Tenant-isolation tests for `/v1/operations/batch` should cover this scenario explicitly: Alice sends a `create` op with Bob's existing entityId; assert Bob's row is unchanged.
