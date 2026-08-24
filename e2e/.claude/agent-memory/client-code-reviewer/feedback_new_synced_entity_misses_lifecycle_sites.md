---
name: new-synced-entity-misses-lifecycle-sites
description: Adding a new synced entity type wires the sync/read path thoroughly but skips the whole-account lifecycle sites (wipeUserData, exportRecoveryData, label maps)
metadata:
  type: feedback
---

When a new server-replicated entity is added to the client (new IDB store + `EntityType` arm),
the sync path gets wired exhaustively — dispatch arm, bootstrap mapping, `ENTITY_STORE_BY_TYPE`,
appResource scope, AppDataProvider `refresh*`/`all*` — because those are all compile-time
exhaustive (`never` switches, `Record<EntityType, …>`).

The sites that get MISSED are the ones typed with a hand-written store-name tuple or a
`Partial<Record<EntityType, …>>`, so TypeScript stays silent:
- `db/accountHelpers.ts` → `wipeUserData` store list + its `UserScopedStore`/`WipeStores` unions
  (sign-out leaks orphan rows for the new entity, and a re-login "seed if empty" then no-ops)
- `db/exportRecoveryData.ts` → `buildLocalSnapshotExportFile` (recovery snapshot silently omits it)
- `components/syncIssueRowLogic.ts` → `ENTITY_TYPE_LABELS` (degrades to the raw wire name)
- `db/indexedDB.ts` → `wipeCachedEntitiesAndSyncState` (correctly excluded when the store is
  created in a LATER version step than the wipe — check the version ordering before flagging)

**Why:** these are whole-account lifecycle paths, not per-entity CRUD, so they don't surface in
the feature's own e2e or unit tests; the leak only shows on sign-out → sign-in on the same device.

**How to apply:** on any diff that adds an `EntityType` member, grep for the existing entity's
store name (e.g. `'workContexts'`) across `src/db` and `src/components` and check every hit that
is a literal tuple/array rather than an exhaustive switch. See also
[[feedback-seed-if-empty-races-first-pull]].
