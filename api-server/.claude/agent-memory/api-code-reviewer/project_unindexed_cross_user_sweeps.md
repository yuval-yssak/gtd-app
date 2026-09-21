---
name: unindexed-cross-user-sweeps
description: Background-sweep selectors query items across ALL users sorted by updatedTs (COLLSCAN + blocking sort); adding `user` fixes the COLLSCAN but an `_id` sort tiebreak still forces a blocking SORT, and IXSCAN-only test assertions miss it
metadata:
  type: project
---

Every cross-user maintenance/sweep selector added to this codebase so far has been written as
`find({ status: { $in: [...] } }).sort({ updatedTs: -1, _id: 1 })` with no `user` predicate.
`itemsDAO`'s indexes are ALL `user`-prefixed (`{user,status}`, `{user,updatedTs}`, …), so such a
query cannot use any of them: it is a full collection scan plus an in-memory blocking sort, which
MongoDB aborts at 32 MB with `QueryExceededMemoryLimitNoDiskUseAllowed` unless `allowDiskUse` is
set. `abstractDAO.findSequence` passes no `allowDiskUse` and applies no cursor `limit`.

Seen in `lib/brief/briefTargets.ts::findBriefTargets` (item-brief Phase 2, 2026-09-20), where the
unit test only seeds ~1.2k tiny docs so it passes comfortably under the limit and the gap is
invisible until staging/production data hits it.

**Why:** the sweep is naturally phrased "all users, newest first", and the per-user index layout
is only obvious if you open `itemsDAO.init`.

**How to apply:** whenever a diff adds a query with no `user` field in the filter, open the DAO's
`createIndexes` call and check whether an index actually leads with the queried/sorted fields. If
not, require either a supporting index, a per-user outer loop over the `user` collection (which
lets the existing `{user, updatedTs}` index serve the sort), or an explicit
`allowDiskUse` + cursor `limit`. A unit test with a few thousand docs is NOT evidence the sort fits.

## Adding `user` to the filter removes the COLLSCAN but NOT the blocking sort

Round-2 follow-up on the same code: `{ user, status: { $in } }` sorted `{ updatedTs: -1, _id: 1 }`
explains as `SORT → FETCH → IXSCAN {user:1, status:1}`. The planner picks the *status* index (the
selective predicate), so `updatedTs` order still needs an in-memory blocking sort of that user's
whole matching set. Even an explicit `hint({user:1, updatedTs:1})` keeps the `SORT` stage — because
the compound sort's `_id: 1` tiebreak is not in that index.

Dropping the `_id` tiebreak (`sort: { updatedTs: -1 }` alone) collapses the plan to a pure
`FETCH → IXSCAN` backward index walk with **no SORT stage at all**. The `_id` tiebreak is only
load-bearing for skip/limit re-query paging; a single continuously-consumed cursor does not need it.

**Verification recipe** (an `IXSCAN`-only assertion is vacuous here — `{user,status}` satisfies both
"contains IXSCAN" and "contains \"user\":1" while still sorting in memory): assert on the winning
plan's top-level `stage`, e.g. `expect(winningPlan.stage).not.toBe('SORT')`, or assert the chosen
`indexName`. Print the real plan with `.explain('queryPlanner')` before trusting a claim about which
index a query "rides".
