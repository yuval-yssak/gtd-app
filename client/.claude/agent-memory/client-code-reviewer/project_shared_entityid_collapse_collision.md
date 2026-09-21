---
name: shared-entityid-collapse-collision
description: queueSyncOp collapses the offline queue by entityId ALONE — any sidecar entity reusing the parent's _id silently annihilates the parent's ops
metadata:
  type: project
---

`queueSyncOp` in `client/src/db/syncHelpers.ts` selects collapse candidates with
`q.entityId === entityId && q.opType !== 'rsvp'` — **no `entityType` comparison**. Every
collapse rule (create→update merge, create→delete drop-both, update→delete) therefore fires
across entity *types* whenever two entities share an `entityId`.

**Why:** historically every entity had a globally unique UUID `_id`, so entityId alone was a
sufficient key and the omission was invisible. The `itemBrief` sidecar (2026-09, feat/item-brief)
was the first design to deliberately set `_id === item._id`, which turned the latent bug into
data loss: an offline item-create plus a brief-create-then-clear empties the queue entirely
(the item never reaches the server); an item-create plus a brief-update collapses into a single
`itemBrief create` whose snapshot is the brief, destroying the item create.

**How to apply:** whenever a change introduces or touches an entity whose `_id` is borrowed from
another entity (sidecars, per-item metadata rows, join rows), check the collapse predicate first.
The fix is to key collapse on the `(entityType, entityId)` pair in `queueSyncOp` — and the
regression test belongs in `syncHelpers.test.ts`, not in the sidecar's own mutation test, because
the defect lives in the shared queue, not the feature. Related: [[project_sync_flags_unit_test_gap]].
