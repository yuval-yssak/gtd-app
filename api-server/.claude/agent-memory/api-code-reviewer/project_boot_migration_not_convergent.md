---
name: boot-migration-not-convergent
description: Boot-time backfills in mainLoader must be CONVERGENT (filter stops matching forever), not merely idempotent-per-run; Cloud Run cold starts + every src/scripts/* run re-execute them
metadata:
  type: project
---

A `mainLoader` migration whose "already done" state is expressed by the ABSENCE of a field is not a
one-time migration. `{ field: { $exists: false } }` + `$set` re-fires on every boot the moment the
steady-state code path `$unset`s that field.

**Why:** `loadDataAccess()` runs the whole migration block on every process start. On Cloud Run the
API scales to zero, so a cold start happens many times a day; additionally every one-off script
under `src/scripts/` calls `loadDataAccess()` too (only `retireOrphanedSeriesSuccessor.ts`
deliberately connects raw to avoid boot migrations). Caught on `briefStaleBackfill.ts` (2026-09-21):
its filter re-marked the entire converged item corpus on every cold start, reintroducing the exact
full-corpus sweep it existed to remove.

Contrast the convergent ones already in the tree: `apiTokenScopeMigration` rewrites
`items.clarify` → `items.write`, and nothing ever writes `items.clarify` back, so the filter is
permanently dead after the first run.

**How to apply:** for any new `mainLoader.ts` migration, ask "what re-creates the state this filter
matches?" If the normal runtime path does, it is a recurring full-collection write, not a
migration — require a tri-state marker (e.g. `false` for settled instead of `$unset`), a persisted
migration-version row, or move it off boot to a cron/maintenance endpoint. See
[[unguarded-index-build-on-boot]] for the other boot-time hazard in the same block.
