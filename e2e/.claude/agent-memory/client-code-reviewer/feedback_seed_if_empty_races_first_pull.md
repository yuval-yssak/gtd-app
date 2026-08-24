---
name: seed-if-empty-races-first-pull
description: "Deterministic-id `seedDefaultXIfEmpty` helpers converge across devices but clobber remote renames when the local pull hasn't landed yet
"
metadata:
  type: feedback
---

Seeding helpers of the shape "if the local store is empty for this user, create N default rows
with deterministic ids (`<userId>:default-<i>`)" are justified as cross-device-safe because LWW
converges on the same `_id`. That reasoning is incomplete.

**Why:** the emptiness check reads LOCAL IDB only. On a second device (or the same device after
`wipeUserData`), the store is empty until the first incremental pull lands. Seeding in that window
writes `updatedTs = now`, which is NEWER than the server's row — so LWW makes the local re-seed
win and the user's rename/reorder/deletion on the other device is silently reverted. Deleted
default rows resurrect the same way.

**How to apply:** whenever a diff adds a `seed*IfEmpty` called from a UI entry point, ask what
guarantees a pull completed first. Acceptable fixes: gate the seed behind a completed
initial sync, or make the seed idempotent-by-creation (only create rows whose deterministic id has
never existed, tracked in a device-local marker) rather than emptiness-of-store. Related:
[[feedback-new-synced-entity-misses-lifecycle-sites]].
