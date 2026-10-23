---
name: mongo-query-hazards-undefined-and-exists
description: Two driver/planner traps verified 2026-10-23 — `$set` of an undefined value writes null (no ignoreUndefined), and `{field:{$exists:true}}` + sort on a non-sparse index scans every missing-field row
metadata:
  type: project
---

Two Mongo traps that new scripts/helpers keep walking into (both verified against `gtd-test-mongo`, 2026-10-23, next-actions-rank review):

1. **`$set: { x: maybeUndefined }` stores `x: null`.** `mainLoader.mongoClientOptions()` does not set `ignoreUndefined`, so the driver serializes undefined as null. Strict op schemas (`.optional()`, not `.nullable()`) then reject the row the moment a client or a v1 PATCH spreads it into a snapshot → `/sync/push` 400 jam / PATCH 400 forever. Seen in `backfillItemRanks.writeRankedRows` (`expectedBy: after.expectedBy` on undated rows).
   **How to apply:** in any hand-written `$set` (scripts, bulkWrite), check every value can be undefined; demand conditional spread or `$unset`. Tests must assert the key is ABSENT on a row that had no value, not just that the present-value rows are right.

2. **`{ f: { $exists: true } }` sorted by `f` on a non-sparse `{user, f}` index examines every row MISSING `f` first** (missing indexes as null, null sorts lowest; 5001 keys/docs for 1 result). `{ $type: 'string' }` gives tight bounds (1 key). Seen in `topRankForUser` — called on every create.
   **How to apply:** when a "min/max of an optional field" query is added, ask for `$type` bounds and an explain asserting `totalKeysExamined`, not just IXSCAN. Related: [[unindexed-cross-user-sweeps]].
