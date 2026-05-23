---
name: upsert-set-id-immutable-drift
description: Recurring bug — upserts use `$set: doc` where `doc._id` is a freshly-minted UUID. First run inserts fine; every subsequent matched-path upsert fails with ImmutableField (code 66). Failure is per-row (only writeErrors), so the bulk call doesn't throw — the script silently logs warnings.
metadata:
  type: project
---

`$set: doc` where `doc._id` is a freshly-generated value silently breaks on re-run.

**Why:** MongoDB rejects any update that would change `_id` (immutable since 4.2, error code 66 "ImmutableField"). Including `_id` in `$set` on the upsert path works only when the row is NEW (inserts adopt the supplied `_id`); on a match, the server compares `$set._id` to the existing `_id` and rejects when they differ. Because we always mint a new UUID via `generateId(32)` before building the upsert, every re-run's matched rows fail.

The codebase has a correct reference pattern: `src/dataAccess/calendarIntegrationsDAO.ts:42` splits `_id` and `createdTs` into `$setOnInsert`, leaving only mutable fields in `$set`. Use that shape:

```ts
const { _id, ...mutable } = doc;
update: { $set: mutable, $setOnInsert: { _id } }
```

**Failure mode is sneaky:**
- `ordered: false` bulkWrite reports the failures per-row in `writeErrors` and does NOT abort.
- The script's existing catch arm logs `! upsert failed externalId=…` warnings and keeps going.
- `bulkRes.upsertedIds` is empty on a failure-all-matches batch → counters classify rows as "replaced" even though no replace happened.
- An operation is still written to the `operations` collection (the snapshot is read back from DB, which still has the *old* data), so devices pulling /sync/pull see a no-op update.

**How to apply:** On any review that touches an `updateOne`/`updateMany`/`bulkWrite` with `$set` + `upsert:true`, check whether the value object includes `_id`. If yes — flag it. The correct pattern is `$setOnInsert: { _id }` + `$set: <rest>`. Also flag any inline comment claiming "$set leaves existing _id intact on replace" — that's the load-bearing wrong mental model.

Seen in:
- `src/scripts/importFacileThings.ts` (pre-batched and batched-bulk versions both)
- Likely candidates: any "import from external source" script written after the calendarIntegrations pattern was established.

Related: [[replaceById-tenant-bypass]] — different bug, same family (developers mis-modeling MongoDB's upsert-by-not-_id semantics).
