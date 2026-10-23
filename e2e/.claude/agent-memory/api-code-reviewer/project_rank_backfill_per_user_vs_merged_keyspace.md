---
name: rank-backfill-per-user-vs-merged-keyspace
description: Server rank backfills key per user, but the client merges all signed-in accounts' rows of a status into ONE ranked list (ownerIdsOfStatus) — per-user keys interleave by value, not by legacy order.
metadata:
  type: project
---
Server-side rank planning (backfillItemRanks next-action + open-list passes) mints keys per user independently, whereas the client sorts a multi-account merged list by rank across owners (`client/src/lib/rankSections.ts` ownerIdsOfStatus "share the keyspace").

**Why:** two accounts both keyed from `a0`/after-their-own-max interleave by key value, so "an untouched list looks as before" holds per account only. Accepted so far as a one-off cost (flagged non-blocking 2026-10-23).

**How to apply:** when reviewing any server path that mints/re-keys ranks in bulk, ask whether the multi-account merged view matters; don't re-flag as blocking unless the team changes stance. Related: [[op-cursor-ordering-invariants]].
