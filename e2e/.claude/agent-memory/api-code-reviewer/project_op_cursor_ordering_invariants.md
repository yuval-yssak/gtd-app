---
name: op-cursor-ordering-invariants
description: Sync op-log ordering invariants that keep getting violated in new ways — ts/_id co-allocation, forward-only cursor consumers, and the recurring "op silently skipped forever" bug class
metadata:
  type: project
---

The `operations` log has produced the same bug class repeatedly: **an op is written with a `ts`
below a device's already-advanced forward-only pull cursor, so that device never receives it.**
Server Mongo is correct; IndexedDB is stale until sign-out/in re-bootstrap. Confirmed instances:
stale `ctx.now` captured at sync-run start; same-ms random-UUID tie order; bootstrap-vs-concurrent
-import race; `/sync/issues/:opId/retry` bumping `ts` in place.

**Why:** the pull cursor is strictly forward-only over the compound `(ts, _id)` pair, and it is
forward-only in *three independent places* (server pull boundary, client `advanceSyncCursor`,
purge floor). Any code path that writes an op whose sort position is below where a device already
looked creates permanent, silent, per-device data loss — there is no retry and no error surface.

**How to apply:** on any change touching op writes or cursors, check these specifically:
- Does the path set `ts` from a clock captured earlier than the insert? (Sync runs, batch flows,
  and anything with `ctx.now` / `opts.now` are the usual offenders.)
- Does it mutate `ts` on an existing row *without* also reallocating `_id`? The `_id` ms-prefix
  participates in the sort, so a lone `ts` bump does NOT move the op — it strands it. Republish
  under a fresh identity (insert-new-then-delete-old) instead.
- Does it advertise a cursor that could be BELOW what the client sent? The client's forward-only
  guard silently rejects it, which can pin a cursor (and the purge floor) indefinitely.
- Does it rewind an established cursor (e.g. re-bootstrap `$set`)? That drags the whole user's
  purge floor backwards.

Reviews of this area should trace op-loss scenarios explicitly rather than reasoning only about
the happy path — every instance so far passed all tests and looked correct in isolation.
Related: [[review-adversarial-op-loss-tracing]]
